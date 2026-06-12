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
import type { TranscriptSegment } from "@sdr/shared";
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
const GAP_FLUSH_MS = 700;
const MIN_FLUSH_S = 1.0;
const FLUSH_POLL_MS = 250;

// Chunks awaiting inference. One request is in flight at a time (the child
// processes sequentially anyway); if the machine can't keep up, the oldest
// queued chunks are dropped rather than falling ever further behind live.
const QUEUE_MAX = 3;

/** Transcript history kept for late-joining clients (the client caps too). */
const HISTORY_MAX = 200;

/** Chunks quieter than this RMS (~ -60 dBFS) are silence — skip inference. */
const SILENCE_RMS = 1e-3;

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

  constructor(private emit: (segments: TranscriptSegment[]) => void) {}

  /** Absolute path to the whisper-server binary, or null if not installed.
   *  Reads the live PATH explicitly — Bun.which() otherwise snapshots it at
   *  process startup (see IsmReceiver.resolve). */
  static resolveServer(): string | null {
    const override = process.env.WHISPER_SERVER_BIN;
    if (override) return override;
    return Bun.which("whisper-server", { PATH: process.env.PATH ?? "" });
  }

  /** Best ggml model found, or null. Searches WHISPER_MODEL, then ggml-*.bin
   *  in WHISPER_MODEL_DIR, ./models and ~/.cache/whisper.cpp, preferring the
   *  largest file (bigger model = better transcription). */
  static findModel(): { path: string; name: string } | null {
    const explicit = process.env.WHISPER_MODEL;
    if (explicit && isFile(explicit)) {
      return { path: resolve(explicit), name: modelName(explicit) };
    }
    let best: { path: string; size: number } | null = null;
    for (const file of candidateModels()) {
      if (/silero|vad/i.test(basename(file))) continue; // VAD models aren't speech models
      const size = fileSize(file);
      if (size > 0 && (!best || size > best.size)) best = { path: file, size };
    }
    return best ? { path: best.path, name: modelName(best.path) } : null;
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
    return this.history;
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
    // / decode mode entered) instead of waiting for it to reach TARGET_S.
    this.flushTimer = setInterval(() => {
      if (this.bufLen > 0 && Date.now() - this.lastFeedAt > GAP_FLUSH_MS) {
        this.flushBuffer();
      }
    }, FLUSH_POLL_MS);
  }

  /** Kill whisper-server and drop buffered audio (history is kept). */
  stop() {
    this.wantRunning = false;
    this.ready = false;
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
    const all = this.takeBuffer();
    if (all.length >= MIN_FLUSH_S * WHISPER_RATE) this.enqueue(all);
  }

  /** The buffer hit TARGET_S: cut at the quietest 20 ms frame near the end so
   *  we don't split a word, keep the remainder for the next chunk. */
  private cutAtQuietPoint() {
    const all = this.takeBuffer();
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
    this.enqueue(all.subarray(0, best));
    const rest = all.slice(best);
    if (rest.length > 0) {
      this.pieces = [rest];
      this.bufLen = rest.length;
    }
  }

  /** Drain the accumulated pieces into one contiguous buffer. */
  private takeBuffer(): Float32Array {
    const all = new Float32Array(this.bufLen);
    let o = 0;
    for (const p of this.pieces) {
      all.set(p, o);
      o += p.length;
    }
    this.pieces = [];
    this.bufLen = 0;
    return all;
  }

  private enqueue(chunk: Float32Array) {
    if (chunk.length === 0) return;
    // An unmodulated carrier or dead air is silence after demod — skip it.
    let e = 0;
    for (let i = 0; i < chunk.length; i++) e += chunk[i]! * chunk[i]!;
    if (Math.sqrt(e / chunk.length) < SILENCE_RMS) return;

    this.queue.push({
      pcm: floatToInt16(chunk),
      freqHz: this.bufFreqHz,
      time: Date.now(),
      durationS: chunk.length / WHISPER_RATE,
    });
    if (this.queue.length > QUEUE_MAX) {
      this.queue.shift();
      console.warn("[transcribe] whisper can't keep up — dropping oldest chunk");
    }
    this.pump();
  }

  // --- inference ------------------------------------------------------------

  private pump() {
    if (!this.ready || this.inFlight) return;
    const job = this.queue.shift();
    if (!job) return;
    this.inFlight = true;
    this.transcribe(job)
      .catch((err) => console.warn(`[transcribe] inference failed: ${err}`))
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }

  private async transcribe(job: PendingChunk) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([wavBytes(job.pcm, WHISPER_RATE)], { type: "audio/wav" }),
      "chunk.wav",
    );
    form.append("response_format", "json");
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.error) throw new Error(body.error);

    const text = cleanText(body.text ?? "");
    if (!text) return;
    // Identical back-to-back chunks are almost always a hallucination loop
    // (whisper latching onto music or noise), not a station repeating itself.
    if (text === this.lastText) return;
    this.lastText = text;

    const segment: TranscriptSegment = {
      id: this.nextId++,
      time: job.time,
      text,
      freqHz: job.freqHz,
      durationS: Math.round(job.durationS * 10) / 10,
    };
    this.history.push(segment);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }
    this.emit([segment]);
  }

  // --- child lifecycle --------------------------------------------------------

  private spawn() {
    if (this.proc) return;
    const bin = Transcriber.resolveServer();
    const model = Transcriber.findModel();
    if (!bin || !model) {
      console.warn("[transcribe] whisper-server or model missing — cannot start");
      return;
    }
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
      return;
    }
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
