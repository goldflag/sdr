// Live speech-to-text of the demodulated audio, delegated to whisper.cpp
// (https://github.com/ggml-org/whisper.cpp).
//
// We transcribe nothing ourselves. A `whisper-server` child is spawned with a
// local ggml model (it keeps the model loaded across requests); demodulated
// 48 kHz audio is low-passed, decimated to the 16 kHz mono PCM whisper expects,
// chopped into utterance-sized chunks at quiet points, and POSTed to the
// child's /inference endpoint as WAV. Resulting text segments are surfaced to
// the UI over the websocket.
//
// For a live feel, the open (still-accumulating) utterance is additionally
// re-transcribed every PREVIEW_STEP_S whenever the inference slot is idle, and
// pushed as a preview segment (final: false) that the client re-renders in
// place — so text starts appearing ~2 s after speech instead of after the
// utterance completes. The eventual full-chunk transcription replaces the
// preview under the same id (or tombstones it if it turned out to be nothing).
//
// If the whisper-server binary or a ggml model can't be found, available() is
// false and the server tells the client to disable the transcription toggle —
// there is no built-in fallback.
//
// Environment overrides:
//   WHISPER_SERVER_BIN  path to the whisper-server binary
//   WHISPER_MODEL       path to a ggml model file (skips the directory search)
//   WHISPER_MODEL_DIR   extra directory to search for ggml-*.bin models
//   WHISPER_LANG        spoken language hint (e.g. "de", "auto"); default "en"
//   WHISPER_PORT        fixed port for the child (default: an ephemeral port)
//   WHISPER_SERVER_ARGS extra args appended to the whisper-server invocation

import type { Subprocess } from "bun";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { TranscriptSegment, TranscribeStatus } from "@sdr/shared";
import { AUDIO_RATE } from "@sdr/shared";
import { designLowpass, RealFir } from "./dsp/filters";
import { LinearResampler, floatToInt16 } from "./dsp/resample";

/** Sample rate whisper models are trained on. */
const WHISPER_RATE = 16_000;

// Chunking: whisper is a windowed model, not a streaming one, so we transcribe
// utterance-sized chunks. A buffer is cut once it reaches TARGET_S, at the
// quietest 20 ms frame within the last SEARCH_S (to avoid splitting a word),
// or flushed whole when the audio stops for GAP_FLUSH_MS (squelch closed,
// transmission ended, retune). Chunks shorter than MIN_FLUSH_S are dropped —
// too short to transcribe meaningfully.
const TARGET_S = 8;
const SEARCH_S = 1.5;
const GAP_FLUSH_MS = 500;
const MIN_FLUSH_S = 1.0;
const FLUSH_POLL_MS = 250;

// Live previews: re-transcribe the open buffer after every PREVIEW_STEP_S of
// new audio, but only when whisper is otherwise idle — finalised chunks always
// take priority, so previews cost latency nothing and are skipped when the
// machine is busy. Must exceed MIN_FLUSH_S: a buffer too short to finalise can
// then never have shown a preview, so nothing dangles when it's dropped.
const PREVIEW_STEP_S = 1.5;

// Chunks awaiting inference. One request is in flight at a time (the child
// processes sequentially anyway); if the machine can't keep up, the oldest
// queued chunks are dropped rather than falling ever further behind live.
const QUEUE_MAX = 3;

/** Transcript history kept for late-joining clients (the client caps too). */
const HISTORY_MAX = 200;

/** Chunks quieter than this RMS (~ -60 dBFS) are silence — skip inference. */
const SILENCE_RMS = 1e-3;

// Per-segment confidence gates on the verbose_json response. Whisper reports
// both "this probably isn't speech" (no_speech_prob) and "I'm guessing"
// (avg_logprob) — hallucinations over music/noise score high on one or both,
// e.g. white noise transcribes as "(water running)" with no_speech_prob ≈ 0.8
// while real speech sits near 0.
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1.0;

/** Previous transcript text fed back as whisper's prompt, so names and
 *  spelling stay consistent across chunks (≲ whisper's 224-token cap). */
const PROMPT_MAX_CHARS = 600;

// A wedged child would otherwise hold `inFlight` forever and silently stop
// transcription. Time the request out, and after consecutive timeouts kill
// the child — the respawn logic brings up a fresh one.
const INFERENCE_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_TIMEOUTS = 2;

// Model loading is slow (seconds; first Core ML run can be much longer) — poll
// the child's HTTP port until it answers before sending work.
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

// Same respawn policy as the rtl_433 delegate: bring an unexpectedly dead
// child back, but stop retrying a child that dies immediately every time.
const RESPAWN_DELAY_MS = 1000;
const MAX_RAPID_RESTARTS = 3;
const HEALTHY_RUN_MS = 30_000;

interface PendingChunk {
  pcm: Int16Array;
  freqHz: number;
  time: number; // epoch ms when the chunk ended
  durationS: number;
  /** Id of the preview segment shown for this utterance, to be replaced by the
   *  final text (or tombstoned). Null when no preview was ever emitted. */
  previewId: number | null;
}

/** One segment of whisper-server's verbose_json response. */
interface WhisperSegment {
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

export interface TranscriberHooks {
  /** Newly transcribed segments, ready to broadcast. */
  emit: (segments: TranscriptSegment[]) => void;
  /** Engine lifecycle changes (loading / ready / lagging / failed / off). */
  status: (status: TranscribeStatus) => void;
}

export class Transcriber {
  private proc: Subprocess<"ignore", "ignore", "ignore"> | null = null;
  private port = 0;
  private ready = false;
  private wantRunning = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rapidRestarts = 0;
  private spawnedAt = 0;

  // 48 kHz float audio in → anti-alias low-pass → 16 kHz for whisper. The
  // cutoff sits below the 8 kHz output Nyquist with room for the transition.
  private fir = new RealFir(designLowpass(81, 7000 / AUDIO_RATE));
  private resampler = new LinearResampler(AUDIO_RATE, WHISPER_RATE);

  // Accumulating utterance buffer (16 kHz float), tagged with the frequency it
  // was received on; a retune flushes it so chunks never mix two stations.
  private pieces: Float32Array[] = [];
  private bufLen = 0;
  private bufFreqHz = 0;
  private lastFeedAt = 0;

  private queue: PendingChunk[] = [];
  private inFlight = false;

  private history: TranscriptSegment[] = [];
  private nextId = 1;
  private lastText = "";

  // Live preview of the open utterance. `gen` increments every time the
  // buffer is taken (cut/flush), so a preview computed for an utterance that
  // ended mid-inference can be recognised as stale and discarded.
  private preview: TranscriptSegment | null = null;
  private previewGen = -1;
  private gen = 0;
  private lastPreviewLen = 0;

  // Rolling transcript context used as whisper's prompt; only applied to
  // chunks from the same station, so one station's text can't prime another's.
  private context = "";
  private contextFreqHz = 0;

  /** Model picked via the UI; null means "largest found". */
  private preferredModel: string | null = null;

  private currentStatus: TranscribeStatus = "off";
  private consecutiveTimeouts = 0;

  constructor(private hooks: TranscriberHooks) {}

  private setStatus(status: TranscribeStatus) {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.hooks.status(status);
  }

  /** Absolute path to the whisper-server binary, or null if not installed.
   *  Reads the live PATH explicitly — Bun.which() otherwise snapshots it at
   *  process startup (see IsmReceiver.resolve). */
  static resolveServer(): string | null {
    const override = process.env.WHISPER_SERVER_BIN;
    if (override) return override;
    return Bun.which("whisper-server", { PATH: process.env.PATH ?? "" });
  }

  /** Every speech model found (ggml-*.bin in WHISPER_MODEL_DIR, ./models and
   *  ~/.cache/whisper.cpp), largest first. A WHISPER_MODEL override is listed
   *  first regardless of size. First hit wins for duplicate names. */
  static listModels(): { path: string; name: string; size: number }[] {
    const out: { path: string; name: string; size: number }[] = [];
    const seen = new Set<string>();
    const add = (file: string) => {
      const name = modelName(file);
      const size = fileSize(file);
      if (size > 0 && !seen.has(name)) {
        seen.add(name);
        out.push({ path: resolve(file), name, size });
      }
    };
    for (const file of candidateModels()) {
      if (/silero|vad/i.test(basename(file))) continue; // VAD models aren't speech models
      add(file);
    }
    out.sort((a, b) => b.size - a.size);
    const explicit = process.env.WHISPER_MODEL;
    if (explicit && isFile(explicit)) {
      const name = modelName(explicit);
      const rest = out.filter((m) => m.name !== name);
      return [{ path: resolve(explicit), name, size: fileSize(explicit) }, ...rest];
    }
    return out;
  }

  /** Default model (the WHISPER_MODEL override or the largest found). */
  static findModel(): { path: string; name: string } | null {
    return Transcriber.listModels()[0] ?? null;
  }

  /** Silero VAD model, if one is present — lets whisper skip music/static
   *  instead of hallucinating lyrics over it. */
  static findVadModel(): string | null {
    for (const file of candidateModels()) {
      if (/silero|vad/i.test(basename(file))) return file;
    }
    return null;
  }

  /** Whether transcription is possible (binary + model both present). */
  static available(): boolean {
    return Transcriber.resolveServer() != null && Transcriber.findModel() != null;
  }

  /** Display name of the model that would be used, or null. */
  static modelName(): string | null {
    return Transcriber.findModel()?.name ?? null;
  }

  snapshot(): TranscriptSegment[] {
    return this.preview ? [...this.history, this.preview] : this.history;
  }

  /** Switch to another model by name. If running, the child is swapped out
   *  for one loading the new model (status goes loading → ready). */
  setModel(name: string) {
    if (name === this.preferredModel) return;
    this.preferredModel = name;
    if (!this.wantRunning) return;
    this.ready = false;
    this.rapidRestarts = 0;
    const proc = this.proc;
    this.proc = null; // detach first so onExit doesn't treat this as a crash
    proc?.kill();
    this.spawn();
  }

  /** Spawn whisper-server and start accepting audio. No-op if running. */
  start() {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.rapidRestarts = 0;
    this.fir = new RealFir(designLowpass(81, 7000 / AUDIO_RATE));
    this.resampler = new LinearResampler(AUDIO_RATE, WHISPER_RATE);
    this.spawn();
    // Flush a pending utterance once the audio stops (squelch closed / retune
    // / decode mode entered) instead of waiting for it to reach TARGET_S; in
    // between, preview the growing utterance whenever whisper sits idle.
    this.flushTimer = setInterval(() => {
      if (this.bufLen > 0 && Date.now() - this.lastFeedAt > GAP_FLUSH_MS) {
        this.flushBuffer();
      } else {
        this.maybePreview();
      }
    }, FLUSH_POLL_MS);
  }

  /** Kill whisper-server and drop buffered audio (history is kept). */
  stop() {
    this.wantRunning = false;
    this.ready = false;
    this.consecutiveTimeouts = 0;
    this.setStatus("off");
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.pieces = [];
    this.bufLen = 0;
    this.queue = [];
    // A preview the user already saw shouldn't vanish — keep it as final.
    this.promotePreview(this.preview?.id ?? null);
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  /** Feed a block of demodulated 48 kHz mono audio received on `freqHz`.
   *  Call only while the squelch is open — closed-squelch noise poisons the
   *  transcription and the gap it leaves is what flushes an utterance. */
  feed(audio: Float32Array, freqHz: number) {
    if (!this.wantRunning || audio.length === 0) return;
    // Retuned mid-utterance — finish the old station's chunk first.
    if (this.bufLen > 0 && freqHz !== this.bufFreqHz) this.flushBuffer();
    this.bufFreqHz = freqHz;
    const ds = this.resampler.process(this.fir.process(audio));
    if (ds.length > 0) {
      this.pieces.push(ds);
      this.bufLen += ds.length;
    }
    this.lastFeedAt = Date.now();
    if (this.bufLen >= TARGET_S * WHISPER_RATE) this.cutAtQuietPoint();
  }

  // --- chunking -------------------------------------------------------------

  /** Enqueue the whole pending buffer (end of an utterance). */
  private flushBuffer() {
    const { audio, previewId } = this.takeBuffer();
    if (audio.length >= MIN_FLUSH_S * WHISPER_RATE) this.enqueue(audio, previewId);
    else this.promotePreview(previewId); // too short to redo — keep what was shown
  }

  /** The buffer hit TARGET_S: cut at the quietest 20 ms frame near the end so
   *  we don't split a word, keep the remainder for the next chunk. */
  private cutAtQuietPoint() {
    const { audio: all, previewId } = this.takeBuffer();
    const frame = Math.round(0.02 * WHISPER_RATE);
    const searchStart = Math.max(frame, all.length - Math.round(SEARCH_S * WHISPER_RATE));
    let best = all.length;
    let bestEnergy = Infinity;
    for (let s = searchStart; s + frame <= all.length; s += frame) {
      let e = 0;
      for (let i = s; i < s + frame; i++) e += all[i]! * all[i]!;
      if (e < bestEnergy) {
        bestEnergy = e;
        best = s;
      }
    }
    this.enqueue(all.subarray(0, best), previewId);
    const rest = all.slice(best);
    if (rest.length > 0) {
      this.pieces = [rest];
      this.bufLen = rest.length;
    }
  }

  /** Drain the accumulated pieces into one contiguous buffer, ending the open
   *  utterance: its preview id (if one was shown) now belongs to the caller,
   *  and any preview inference still in flight becomes stale. */
  private takeBuffer(): { audio: Float32Array; previewId: number | null } {
    const audio = new Float32Array(this.bufLen);
    let o = 0;
    for (const p of this.pieces) {
      audio.set(p, o);
      o += p.length;
    }
    this.pieces = [];
    this.bufLen = 0;
    const previewId = this.previewGen === this.gen ? (this.preview?.id ?? null) : null;
    this.gen++;
    this.lastPreviewLen = 0;
    return { audio, previewId };
  }

  private enqueue(chunk: Float32Array, previewId: number | null) {
    if (chunk.length === 0) return;
    // An unmodulated carrier or dead air is silence after demod — skip it.
    let e = 0;
    for (let i = 0; i < chunk.length; i++) e += chunk[i]! * chunk[i]!;
    if (Math.sqrt(e / chunk.length) < SILENCE_RMS) {
      this.promotePreview(previewId); // can't happen with a real preview, but don't dangle
      return;
    }

    this.queue.push({
      pcm: floatToInt16(chunk),
      freqHz: this.bufFreqHz,
      time: Date.now(),
      durationS: chunk.length / WHISPER_RATE,
      previewId,
    });
    if (this.queue.length > QUEUE_MAX) {
      const dropped = this.queue.shift()!;
      this.tombstone(dropped);
      console.warn("[transcribe] whisper can't keep up — dropping oldest chunk");
      // Surface it (model too big for the machine?) — but not while the model
      // is still loading, where a backlog is normal and clears once ready.
      if (this.currentStatus === "ready") this.setStatus("lagging");
    }
    this.pump();
  }

  /** Keep a preview the user already saw as the final text (used when its
   *  utterance ends without a full-quality re-transcription). */
  private promotePreview(previewId: number | null) {
    if (previewId == null || this.preview?.id !== previewId) return;
    const segment: TranscriptSegment = { ...this.preview, final: true };
    this.preview = null;
    this.pushHistory(segment);
    this.hooks.emit([segment]);
  }

  /** Append to the late-joiner history, replacing any same-id entry (a final
   *  superseding a promoted preview) and keeping the cap. */
  private pushHistory(segment: TranscriptSegment) {
    this.history = this.history.filter((s) => s.id !== segment.id);
    this.history.push(segment);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }
  }

  /** The utterance produced nothing usable — tell clients to remove its
   *  preview (an empty-text final is the removal marker). */
  private tombstone(job: PendingChunk) {
    if (job.previewId == null) return;
    if (this.preview?.id === job.previewId) this.preview = null;
    this.hooks.emit([
      {
        id: job.previewId,
        time: job.time,
        text: "",
        freqHz: job.freqHz,
        durationS: Math.round(job.durationS * 10) / 10,
        final: true,
      },
    ]);
  }

  // --- inference ------------------------------------------------------------

  private pump() {
    if (!this.ready || this.inFlight) return;
    const job = this.queue.shift();
    if (!job) return;
    this.inFlight = true;
    this.transcribe(job)
      .catch((err) => {
        console.warn(`[transcribe] inference failed: ${err}`);
        this.tombstone(job); // its preview can't be replaced any more
      })
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }

  /** POST one PCM chunk to the child and return the trustworthy text ("" when
   *  whisper found nothing usable). Shared by finals and previews. */
  private async postChunk(pcm: Int16Array, freqHz: number): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([wavBytes(pcm, WHISPER_RATE)], { type: "audio/wav" }),
      "chunk.wav",
    );
    form.append("response_format", "verbose_json");
    // Prime whisper with the station's own recent text so names and spelling
    // stay consistent across chunk boundaries.
    if (this.context && freqHz === this.contextFreqHz) {
      form.append("prompt", this.context);
    }

    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        this.onInferenceTimeout();
      }
      throw err;
    }
    this.consecutiveTimeouts = 0;
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
    const body = (await res.json()) as {
      text?: string;
      error?: string;
      segments?: WhisperSegment[];
    };
    if (body.error) throw new Error(body.error);
    return usableText(body);
  }

  private async transcribe(job: PendingChunk) {
    const text = await this.postChunk(job.pcm, job.freqHz);

    // Caught up after falling behind — the queue has drained.
    if (this.currentStatus === "lagging" && this.queue.length === 0) {
      this.setStatus("ready");
    }

    // Identical back-to-back chunks are almost always a hallucination loop
    // (whisper latching onto music or noise), not a station repeating itself.
    if (!text || text === this.lastText) {
      this.tombstone(job);
      return;
    }
    this.lastText = text;
    this.context = text.slice(-PROMPT_MAX_CHARS);
    this.contextFreqHz = job.freqHz;

    const segment: TranscriptSegment = {
      id: job.previewId ?? this.nextId++,
      time: job.time,
      text,
      freqHz: job.freqHz,
      durationS: Math.round(job.durationS * 10) / 10,
      final: true,
    };
    if (this.preview?.id === segment.id) this.preview = null;
    this.pushHistory(segment);
    this.hooks.emit([segment]);
  }

  // --- live preview of the open utterance ------------------------------------

  /** Re-transcribe the open buffer when whisper is idle and PREVIEW_STEP_S of
   *  new audio has arrived, so text appears while the utterance is still being
   *  spoken. Finals always win the slot: a queued chunk suppresses previews. */
  private maybePreview() {
    if (!this.ready || this.inFlight || this.queue.length > 0) return;
    if (this.bufLen < this.lastPreviewLen + PREVIEW_STEP_S * WHISPER_RATE) return;
    this.lastPreviewLen = this.bufLen;
    const audio = this.peekBuffer();
    const gen = this.gen;
    const freqHz = this.bufFreqHz;
    this.inFlight = true;
    this.runPreview(audio, freqHz, gen)
      .catch((err) => console.warn(`[transcribe] preview failed: ${err}`))
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }

  private async runPreview(audio: Float32Array, freqHz: number, gen: number) {
    const text = await this.postChunk(floatToInt16(audio), freqHz);
    // The utterance was cut/flushed while we were transcribing — the result
    // describes audio that a final (with the cut's exact bounds) now owns.
    if (gen !== this.gen || !this.wantRunning) return;
    if (!text) return;
    const id = this.previewGen === gen && this.preview ? this.preview.id : this.nextId++;
    const segment: TranscriptSegment = {
      id,
      time: Date.now(),
      text,
      freqHz,
      durationS: Math.round((audio.length / WHISPER_RATE) * 10) / 10,
      final: false,
    };
    this.preview = segment;
    this.previewGen = gen;
    this.hooks.emit([segment]);
  }

  /** The open buffer's contents, coalesced without ending the utterance. */
  private peekBuffer(): Float32Array {
    if (this.pieces.length === 1) return this.pieces[0]!;
    const all = new Float32Array(this.bufLen);
    let o = 0;
    for (const p of this.pieces) {
      all.set(p, o);
      o += p.length;
    }
    this.pieces = [all]; // keep the coalesced form; later feeds append after it
    return all;
  }

  /** A request timed out: the child may be wedged (it would otherwise hold the
   *  single inference slot forever). After a second strike, kill it and let
   *  the respawn logic bring up a fresh one. */
  private onInferenceTimeout() {
    this.consecutiveTimeouts++;
    console.warn(`[transcribe] inference timed out (${this.consecutiveTimeouts})`);
    if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && this.proc) {
      console.warn("[transcribe] whisper-server unresponsive — restarting it");
      this.consecutiveTimeouts = 0;
      this.ready = false;
      this.proc.kill(); // onExit fires with this.proc === p → maybeRespawn
    }
  }

  // --- child lifecycle --------------------------------------------------------

  /** The model to spawn with: the UI-picked one if it still exists, else the
   *  default (WHISPER_MODEL override or largest found). */
  private resolveModel(): { path: string; name: string } | null {
    if (this.preferredModel) {
      const picked = Transcriber.listModels().find((m) => m.name === this.preferredModel);
      if (picked) return picked;
    }
    return Transcriber.findModel();
  }

  private spawn() {
    if (this.proc) return;
    const bin = Transcriber.resolveServer();
    const model = this.resolveModel();
    if (!bin || !model) {
      console.warn("[transcribe] whisper-server or model missing — cannot start");
      this.setStatus("failed");
      return;
    }
    this.setStatus("loading");
    this.port = Number(process.env.WHISPER_PORT) || freePort();
    const vad = Transcriber.findVadModel();
    const lang = process.env.WHISPER_LANG;
    const extra = (process.env.WHISPER_SERVER_ARGS ?? "").split(/\s+/).filter(Boolean);
    const args = [
      bin,
      "-m", model.path,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      ...(lang ? ["-l", lang] : []),
      ...(vad ? ["--vad", "--vad-model", vad] : []),
      ...extra,
    ];
    this.spawnedAt = Date.now();
    const proc = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      onExit: (p, code, signal) => {
        // stop() nulls this.proc before killing, so this.proc === p means the
        // child exited on its own (crash, port clash, bad model).
        if (this.proc === p) {
          this.proc = null;
          this.ready = false;
          console.warn(
            `[transcribe] whisper-server exited unexpectedly (code=${code} signal=${signal})`,
          );
          this.maybeRespawn();
        }
      },
    });
    this.proc = proc;
    console.log(
      `[transcribe] whisper-server starting on :${this.port} (model ${model.name}${vad ? ", VAD" : ""})`,
    );
    void this.waitReady(proc);
  }

  /** Poll the child's HTTP port until it answers (the model load takes a
   *  while), then start draining any queued chunks. */
  private async waitReady(proc: Subprocess) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.proc === proc && Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/`, { method: "GET" });
        if (this.proc !== proc) return;
        this.ready = true;
        this.setStatus("ready");
        console.log("[transcribe] whisper-server ready");
        this.pump();
        return;
      } catch {
        await Bun.sleep(READY_POLL_MS);
      }
    }
    if (this.proc === proc) {
      console.warn("[transcribe] whisper-server never became ready — giving up");
      this.proc = null;
      proc.kill();
      this.setStatus("failed");
    }
  }

  /** Respawn after an unexpected death, with a rapid-failure cap. */
  private maybeRespawn() {
    if (!this.wantRunning || this.respawnTimer) return;
    if (Date.now() - this.spawnedAt > HEALTHY_RUN_MS) this.rapidRestarts = 0;
    if (this.rapidRestarts >= MAX_RAPID_RESTARTS) {
      console.warn(
        `[transcribe] whisper-server died ${MAX_RAPID_RESTARTS} times in a row — giving up until transcription is toggled again`,
      );
      this.setStatus("failed");
      return;
    }
    this.setStatus("loading"); // a restart is on its way
    this.rapidRestarts++;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.wantRunning && !this.proc) this.spawn();
    }, RESPAWN_DELAY_MS);
  }
}

// --- helpers -----------------------------------------------------------------

/** Directories searched for ggml models, in priority order. */
function modelDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.WHISPER_MODEL_DIR) dirs.push(process.env.WHISPER_MODEL_DIR);
  dirs.push(resolve("models"));
  dirs.push(join(homedir(), ".cache", "whisper.cpp"));
  return dirs;
}

/** Every ggml-*.bin under the search directories (absolute paths). */
function candidateModels(): string[] {
  const out: string[] = [];
  for (const dir of modelDirs()) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // directory doesn't exist
    }
    for (const name of names) {
      if (/^ggml-.*\.bin$/.test(name)) out.push(join(dir, name));
    }
  }
  return out;
}

/** "…/ggml-small.en.bin" → "small.en" */
function modelName(path: string): string {
  return basename(path).replace(/^ggml-/, "").replace(/\.bin$/, "");
}

function isFile(path: string): boolean {
  return fileSize(path) > 0;
}

function fileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** Ask the OS for a free TCP port to run the whisper-server child on. */
function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** Extract the trustworthy text from a verbose_json response: drop segments
 *  whisper itself scored as probably-not-speech or low-confidence (how
 *  hallucinations over music, noise and dead air present), then strip
 *  non-speech annotations. Falls back to the whole text when the response
 *  carries no per-segment scores. */
function usableText(body: { text?: string; segments?: WhisperSegment[] }): string {
  if (!body.segments) return cleanText(body.text ?? "");
  const kept = body.segments.filter(
    (s) =>
      (s.no_speech_prob ?? 0) <= NO_SPEECH_THRESHOLD &&
      (s.avg_logprob ?? 0) >= LOGPROB_THRESHOLD,
  );
  return cleanText(kept.map((s) => s.text ?? "").join(" "));
}

/** Strip whisper's non-speech annotations; "" means nothing usable was said.
 *  Bracketed/parenthesised output like "[BLANK_AUDIO]", "(soft music)" or
 *  "♪ …" is whisper narrating non-speech audio, not speech. */
function cleanText(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/^[\[\(].*[\]\)]$/.test(text)) return "";
  if (!/[\p{L}\p{N}]/u.test(text)) return ""; // punctuation / ♪ only
  return text;
}

/** Wrap mono 16-bit PCM in a minimal RIFF/WAVE header. */
function wavBytes(pcm: Int16Array, rate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  dv.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}
