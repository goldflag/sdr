// Radio: the single shared receiver. Orchestrates the rtl_tcp connection
// (rtltcp/connection.ts), the map decode layers (layers.ts), and the DSP chain
// (spectrum + demodulator); applies control messages and emits JSON status and
// binary FFT/audio frames to be broadcast to all WebSocket clients.

import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  type ScanEntry,
  type ServerMessage,
  ISM_SAMPLE_RATE,
  AUDIO_RATE,
  DEFAULT_BANDWIDTH,
  DEFAULT_STATE,
  DIRECT_SAMPLING,
  TUNER_NAME,
  defaultEdges,
  encodeAudioFrame,
  encodeFftFrame,
  gainStepsDb,
} from "@sdr/shared";
import { RtlTcpConnection } from "./rtltcp/connection";
import { SpectrumAnalyzer } from "./dsp/fft";
import { ZoomSpectrum } from "./dsp/zoom";
import { Demodulator } from "./dsp/demod";
import { IsmReceiver } from "./dsp/ism";
import { Nco } from "./dsp/nco";
import { SquelchGate } from "./dsp/squelch";
import { floatToInt16 } from "./dsp/resample";
import { MapLayerScheduler } from "./layers";
import { Scanner } from "./scanner";
import { Transcriber } from "./transcribe";

const FFT_INTERVAL_MS = 50; // ~20 fps
const FFT_SIZE = 2048;
const ISM_BROADCAST_MS = 500; // ISM event log refresh rate
const RDS_BROADCAST_MS = 1000; // RDS station refresh rate (WFM only)

export interface RadioSinks {
  json: (msg: ServerMessage) => void;
  binary: (buf: ArrayBuffer) => void;
}

/** Message types that represent a manual retune and should cancel a scan. */
const MANUAL_TUNE = new Set<ClientMessage["type"]>([
  "setFrequency",
  "setVfoOffset",
  "setMode",
  "setSampleRate",
  "setDirectSampling",
]);

export class Radio {
  private conn: RtlTcpConnection;
  private spectrum = new SpectrumAnalyzer(FFT_SIZE, DEFAULT_STATE.spectrumAvg);
  private zoom = new ZoomSpectrum();
  private demod = new Demodulator();
  private ism = new IsmReceiver();
  private transcriber = new Transcriber({
    emit: (segments) => this.sinks.json({ type: "transcript", segments }),
    status: (status) => {
      this.state.transcribeStatus = status;
      this.broadcastState();
    },
  });
  private layers: MapLayerScheduler;
  private scanner = new Scanner({
    tune: (e) => this.scanTune(e),
    status: (s) => {
      this.scanHolding = s?.holding ?? false;
      this.sinks.json({ type: "scan", status: s });
    },
  });
  private scanHolding = false;
  private vfo = new Nco(DEFAULT_STATE.sampleRate, 0);
  private squelch = new SquelchGate(AUDIO_RATE);
  private deviceInfo: DeviceInfo | null = null;
  private state: RadioState = { ...DEFAULT_STATE };
  private lastFft = 0;
  private lastSignal = 0;
  private lastIsm = 0;
  private lastRds = 0;
  // Receiver settings saved when entering a decode mode (ADS-B / AIS), restored
  // on exit.
  private preDecode: Pick<
    RadioState,
    "centerHz" | "sampleRate" | "gainMode" | "gainDb" | "directSampling"
  > | null = null;

  constructor(private sinks: RadioSinks) {
    // ISM decode is delegated to rtl_433; advertise whether it's installed so
    // the client can disable the ISM tab when it isn't.
    this.state.ismAvailable = IsmReceiver.available();
    // Likewise transcription is delegated to whisper.cpp — the toggle is only
    // offered when the whisper-server binary and a ggml model are both found.
    this.state.transcribeAvailable = Transcriber.available();
    this.refreshTranscribeModels();
    this.conn = new RtlTcpConnection({
      onUp: (h) => {
        this.deviceInfo = {
          tuner: h.tuner,
          tunerName: TUNER_NAME[h.tuner] ?? `tuner ${h.tuner}`,
          gains: gainStepsDb(h.tuner),
        };
        this.sinks.json({ type: "deviceInfo", info: this.deviceInfo });
        this.applyAll();
        this.state.running = true;
        this.broadcastState();
      },
      onDown: (kind) => {
        if (kind === "exit") this.deviceInfo = null;
        this.state.running = false;
        this.broadcastState();
      },
      onIq: (iq) => this.onIq(iq),
      // Raw CU8 IQ is piped to rtl_433 while in ISM mode (feed() no-ops otherwise).
      onRawIq: (bytes) => this.ism.feed(bytes),
      onError: (msg) => this.sinks.json({ type: "error", message: msg }),
    });
    this.layers = new MapLayerScheduler({
      state: this.state,
      send: (msg) => this.sinks.json(msg),
      applyReceiver: () => this.applyReceiver(),
      broadcastState: () => this.broadcastState(),
      saveDecodeState: () => this.saveDecodeState(),
      restoreDecodeState: () => this.restoreDecodeState(),
      maxGain: () => this.maxGain(),
      stopScan: () => this.scanner.stop(),
      exitIsm: () => this.exitIsm(),
    });
  }

  /** The live rtl_tcp control client, or null while disconnected. */
  private get client() {
    return this.conn.client;
  }

  getState(): RadioState {
    return this.state;
  }
  getDeviceInfo(): DeviceInfo | null {
    return this.deviceInfo;
  }

  getTranscripts() {
    return this.transcriber.snapshot();
  }

  async start() {
    // Re-arm transcription after a stop (the whisper child is killed when the
    // last client leaves so an idle server isn't holding a loaded model).
    if (this.state.transcribe) this.transcriber.start();
    await this.conn.start();
  }

  stop() {
    this.conn.stop();
    this.transcriber.stop();
    this.state.running = false;
    this.deviceInfo = null;
    this.broadcastState();
  }

  // --- control ---

  handle(msg: ClientMessage) {
    // Any manual retune cancels an active scan.
    if (this.scanner.active && MANUAL_TUNE.has(msg.type)) this.scanner.stop();

    switch (msg.type) {
      case "start":
        void this.start();
        return;
      case "stop":
        this.stop();
        return;
      case "setFrequency":
        this.state.centerHz = msg.hz;
        this.client?.setFrequency(msg.hz);
        this.syncNotches();
        this.demod.resetRds(); // different station — drop the old RDS data
        this.demod.resetTone();
        this.squelch.reset(); // ...and its power estimate
        this.resetZoom(); // the band moved — drop any zoom window
        // The bins now cover different frequencies; drop the cross-frame average
        // so the new band snaps in instead of morphing out of the old one.
        this.spectrum.reset();
        break;
      case "setSampleRate":
        this.state.sampleRate = msg.hz;
        this.client?.setSampleRate(msg.hz);
        this.vfo.setSampleRate(msg.hz);
        this.reconfigureDemod();
        this.resetZoom(); // captured width changed — zoom window no longer valid
        this.spectrum.reset(); // averaged bins now span a different width
        break;
      case "setMode": {
        this.state.mode = msg.mode;
        this.state.bandwidth = DEFAULT_BANDWIDTH[msg.mode];
        const [lo, hi] = defaultEdges(msg.mode, this.state.bandwidth);
        this.state.filterLow = lo;
        this.state.filterHigh = hi;
        this.reconfigureDemod();
        break;
      }
      case "setBandwidth": {
        this.state.bandwidth = msg.hz;
        const [lo, hi] = defaultEdges(this.state.mode, msg.hz);
        this.state.filterLow = lo;
        this.state.filterHigh = hi;
        this.reconfigureDemod();
        break;
      }
      case "setPassband":
        this.state.filterLow = Math.round(Math.min(msg.low, msg.high));
        this.state.filterHigh = Math.round(Math.max(msg.low, msg.high));
        this.state.bandwidth = this.state.filterHigh - this.state.filterLow;
        this.reconfigureDemod();
        break;
      case "setNr":
        this.state.nrOn = msg.on;
        if (msg.level != null) this.state.nrLevel = msg.level;
        this.demod.setNr(this.state.nrOn, this.state.nrLevel);
        break;
      case "setNb":
        this.state.nbOn = msg.on;
        if (msg.threshold != null) this.state.nbThreshold = msg.threshold;
        this.demod.setNb(this.state.nbOn, this.state.nbThreshold);
        break;
      case "setAgc":
        this.state.agc = msg.mode;
        this.demod.setAgc(msg.mode);
        break;
      case "setNotches":
        this.state.notches = msg.notches.slice(0, 8);
        this.syncNotches();
        break;
      case "setGain":
        this.state.gainMode = msg.mode;
        if (msg.mode === "auto") {
          this.client?.setTunerGainMode(false);
        } else {
          const db = msg.db ?? this.state.gainDb;
          this.state.gainDb = db;
          this.client?.setTunerGainMode(true);
          this.client?.setGainTenthDb(Math.round(db * 10));
        }
        break;
      case "setSquelch":
        this.state.squelchDb = msg.db;
        break;
      case "setToneSquelch":
        this.state.toneSquelch = msg.tone;
        break;
      case "setSpectrumAvg":
        this.state.spectrumAvg = Math.min(1, Math.max(0, msg.level));
        this.spectrum.setAvg(this.state.spectrumAvg);
        this.zoom.setAvg(this.state.spectrumAvg);
        break;
      case "setSpectrumView":
        this.state.spectrumView = msg.view;
        this.configureZoom();
        break;
      case "setPpm":
        this.state.ppm = msg.ppm;
        this.client?.setFreqCorrection(msg.ppm);
        break;
      case "setBiasTee":
        this.state.biasTee = msg.on;
        this.client?.setBiasTee(msg.on);
        break;
      case "setDirectSampling":
        this.state.directSampling = msg.value;
        this.client?.setDirectSampling(msg.value);
        break;
      case "setVfoOffset":
        this.state.vfoOffset = msg.hz;
        this.vfo.setFreq(-msg.hz); // bring the VFO down to DC
        this.syncNotches();
        this.demod.resetRds(); // tuned to a different station within the band
        this.demod.resetTone();
        this.squelch.reset();
        break;
      case "setAdsb":
        this.layers.setLayer("adsb", msg.on);
        break;
      case "setAdsbRef":
        this.layers.setAdsbRef(msg.lat, msg.lon);
        break;
      case "setAis":
        this.layers.setLayer("ais", msg.on);
        break;
      case "setAprs":
        this.layers.setLayer("aprs", msg.on);
        break;
      case "setIsm":
        if (msg.on) this.enterIsm();
        else this.exitIsm();
        break;
      case "setTranscribe":
        // Models may have been added/removed since startup — rescan on enable.
        if (msg.on) this.refreshTranscribeModels();
        this.state.transcribe = msg.on && this.state.transcribeAvailable;
        if (this.state.transcribe) this.transcriber.start();
        else this.transcriber.stop();
        break;
      case "setTranscribeModel":
        if (this.state.transcribeModels.includes(msg.model)) {
          this.state.transcribeModel = msg.model;
          this.transcriber.setModel(msg.model);
        }
        break;
      case "setIsmFreq":
        this.state.ismFreqHz = msg.hz;
        if (this.state.ism) {
          this.state.centerHz = msg.hz;
          this.ism.reset();
          this.applyReceiver();
        }
        break;
      case "scanStart":
        if (
          !this.state.adsb &&
          !this.state.ais &&
          !this.state.aprs &&
          !this.state.ism
        )
          this.scanner.start(msg.config, Date.now());
        break;
      case "scanStop":
        this.scanner.stop();
        break;
      case "scanSkip":
        this.scanner.skip(Date.now());
        break;
    }
    this.broadcastState();
  }

  // --- decode-mode bookkeeping (shared by map layers and ISM) -------------

  /** Save the current receiver tuning so a decode mode can be undone on exit. */
  private saveDecodeState() {
    const s = this.state;
    this.preDecode = {
      centerHz: s.centerHz,
      sampleRate: s.sampleRate,
      gainMode: s.gainMode,
      gainDb: s.gainDb,
      directSampling: s.directSampling,
    };
  }

  /** Restore the receiver tuning saved before entering a decode mode. */
  private restoreDecodeState() {
    const s = this.state;
    if (!this.preDecode) return;
    s.centerHz = this.preDecode.centerHz;
    s.sampleRate = this.preDecode.sampleRate;
    s.gainMode = this.preDecode.gainMode;
    s.gainDb = this.preDecode.gainDb;
    s.directSampling = this.preDecode.directSampling;
    this.preDecode = null;
  }

  /** Rescan the model directories, keeping the user's pick when still valid. */
  private refreshTranscribeModels() {
    const models = Transcriber.listModels();
    this.state.transcribeModels = models.map((m) => m.name);
    if (!models.some((m) => m.name === this.state.transcribeModel)) {
      this.state.transcribeModel = models[0]?.name ?? null;
    }
  }

  /** Tune to max gain (digital decode modes are reception-limited). */
  private maxGain() {
    const gains = this.deviceInfo?.gains ?? [];
    if (gains.length > 0) {
      this.state.gainMode = "manual";
      this.state.gainDb = gains[gains.length - 1]!;
    }
  }

  // --- ISM (rtl_433 delegate) ----------------------------------------------

  /** Retune to the selected ISM band @ 250 kSPS and start the rtl_433 decoder. */
  private enterIsm() {
    if (this.state.ism) return;
    if (!this.state.ismAvailable) return; // rtl_433 not installed — nothing to do
    this.layers.disableAll(); // release the dongle from map mode
    this.scanner.stop();
    this.saveDecodeState();
    const s = this.state;
    s.ism = true;
    s.centerHz = s.ismFreqHz;
    s.sampleRate = ISM_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    this.maxGain();
    this.ism.start(); // spawn rtl_433; raw IQ is fed via the onRawIq tap
    this.lastIsm = 0;
    this.applyReceiver();
  }

  /** Leave ISM and restore the previous receiver settings. */
  private exitIsm() {
    if (!this.state.ism) return;
    this.state.ism = false;
    this.ism.stop(); // kill rtl_433
    this.restoreDecodeState();
    this.applyReceiver();
  }

  // --- device configuration -------------------------------------------------

  /** Push center freq / sample rate / gain / direct sampling to the device. */
  private applyReceiver() {
    const s = this.state;
    const c = this.client;
    this.vfo.setSampleRate(s.sampleRate);
    this.vfo.setFreq(-s.vfoOffset);
    this.reconfigureDemod();
    this.squelch.reset();
    this.resetZoom();
    if (!c) return;
    c.setSampleRate(s.sampleRate);
    c.setDirectSampling(s.directSampling);
    c.setFrequency(s.centerHz);
    if (s.gainMode === "auto") c.setTunerGainMode(false);
    else {
      c.setTunerGainMode(true);
      c.setGainTenthDb(Math.round(s.gainDb * 10));
    }
  }

  /** Push the full current state to the device (after (re)connect). */
  private applyAll() {
    const s = this.state;
    const c = this.client;
    if (!c) return;
    c.setSampleRate(s.sampleRate);
    c.setFreqCorrection(s.ppm);
    c.setAgcMode(false);
    c.setDirectSampling(s.directSampling);
    c.setFrequency(s.centerHz);
    if (s.gainMode === "auto") c.setTunerGainMode(false);
    else {
      c.setTunerGainMode(true);
      c.setGainTenthDb(Math.round(s.gainDb * 10));
    }
    c.setBiasTee(s.biasTee);
    this.vfo.setSampleRate(s.sampleRate);
    this.vfo.setFreq(-s.vfoOffset);
    this.reconfigureDemod();
    this.squelch.reset();
    this.demod.setNr(s.nrOn, s.nrLevel);
    this.demod.setNb(s.nbOn, s.nbThreshold);
    this.demod.setAgc(s.agc);
  }

  private reconfigureDemod() {
    this.demod.configure(
      this.state.mode as Mode,
      this.state.sampleRate,
      this.state.filterLow,
      this.state.filterHigh,
    );
    this.syncNotches();
  }

  /** Map absolute-RF notch frequencies to baseband offsets from the VFO. */
  private syncNotches() {
    const tuned = this.state.centerHz + this.state.vfoOffset;
    this.demod.setNotchOffsets(this.state.notches.map((hz) => hz - tuned));
  }

  /** Retune for the scanner: centre on the channel, VFO at DC, set mode/BW. */
  private scanTune(e: ScanEntry) {
    const s = this.state;
    s.vfoOffset = 0;
    this.vfo.setFreq(0);
    // Entries that omit directSampling mean "off" — restore it, otherwise a
    // prior HF entry's Q-branch mode persists onto a following VHF/UHF entry and
    // that channel just receives noise.
    const ds = e.directSampling ?? DIRECT_SAMPLING.OFF;
    if (ds !== s.directSampling) {
      s.directSampling = ds;
      this.client?.setDirectSampling(ds);
    }
    s.centerHz = e.hz;
    this.client?.setFrequency(e.hz);
    if (e.mode !== s.mode) {
      s.mode = e.mode;
      s.bandwidth = DEFAULT_BANDWIDTH[e.mode];
    }
    if (e.bandwidth) s.bandwidth = e.bandwidth;
    const [lo, hi] = defaultEdges(s.mode, s.bandwidth);
    s.filterLow = lo;
    s.filterHigh = hi;
    this.reconfigureDemod();
    this.squelch.reset();
    this.resetZoom();
    this.broadcastState();
  }

  // --- IQ processing ---

  private onIq(iq: Float32Array) {
    // An active map layer (ADS-B / AIS / APRS) consumes the whole block.
    if (this.layers.processIq(iq, Date.now())) return;

    if (this.state.ism) {
      // Decoding happens in the rtl_433 child (fed raw CU8 via onRawIq); here we
      // just publish its accumulated decodes on the broadcast cadence.
      const now = Date.now();
      if (now - this.lastIsm >= ISM_BROADCAST_MS) {
        this.lastIsm = now;
        this.sinks.json({
          type: "ism",
          events: this.ism.snapshot(),
          bursts: this.ism.totalBursts,
          decoded: this.ism.totalDecoded,
          noiseDb: this.ism.noiseDb,
          freqHz: this.state.centerHz,
        });
      }
      return;
    }

    // Spectrum: when zoomed, the zoom pipeline shifts+decimates a sub-window for
    // a higher-resolution FFT; otherwise the analyzer sees the whole captured
    // band (unshifted). Each frame carries its own centre/rate, so the client
    // composites zoomed and full-band rows on one axis.
    const zoomOn = this.zoom.isActive;
    if (zoomOn) this.zoom.push(iq);
    else this.spectrum.push(iq);
    const now = Date.now();
    if (now - this.lastFft >= FFT_INTERVAL_MS) {
      const frame = zoomOn ? this.zoom.getFrame() : null;
      const bins = zoomOn ? frame?.bins : this.spectrum.getFrame();
      if (bins) {
        this.lastFft = now;
        this.sinks.binary(
          encodeFftFrame(
            zoomOn ? frame!.centerHz : this.state.centerHz,
            zoomOn ? frame!.sampleRate : this.state.sampleRate,
            bins,
          ),
        );
      }
    }

    // Demod path: shift the VFO to DC on a copy, then demodulate.
    const shifted = this.vfo.mix(iq, new Float32Array(iq.length));
    const { audio, powerDb } = this.demod.process(shifted);

    // Drive the scanner with the live channel power.
    if (this.scanner.active) this.scanner.onPower(powerDb, now);

    const dt = iq.length / 2 / this.state.sampleRate;
    const carrierOpen = this.squelch.update(
      powerDb,
      this.state.squelchDb,
      dt,
      now,
    );
    const squelchOpen = carrierOpen && this.toneSquelchOpen();
    // While scanning, only pass audio once parked on an active channel, so we
    // don't blast noise from every silent channel we step across.
    const open = squelchOpen && (!this.scanner.active || this.scanHolding);
    const gated = audio.length > 0 ? this.squelch.shape(audio, open) : null;
    if (gated) {
      this.sinks.binary(encodeAudioFrame(AUDIO_RATE, floatToInt16(gated)));
      // Speech-to-text hears exactly what the user hears (squelch-gated, post
      // NR/AGC). The tuned frequency tags each transcript segment, and a change
      // in it tells the transcriber to finish the previous station's chunk.
      if (this.state.transcribe) {
        this.transcriber.feed(gated, this.state.centerHz + this.state.vfoOffset);
      }
    }
    if (now - this.lastSignal >= 100) {
      this.lastSignal = now;
      this.sinks.json({
        type: "signal",
        channelDb: this.squelch.levelDb,
        squelchOpen: squelchOpen,
        tone: this.demod.detectedTone(),
      });
    }

    // RDS rides along with WFM demodulation; in other modes the decoder isn't
    // fed, so it reports a null station (which clears the client panel).
    if (now - this.lastRds >= RDS_BROADCAST_MS) {
      this.lastRds = now;
      if (process.env.RDS_DEBUG && this.state.mode === "WFM") {
        console.log(`[rds] ${this.demod.rdsDiag()}`);
      }
      this.sinks.json({
        type: "rds",
        station: this.demod.rdsStation(),
        stats: this.demod.rdsStats(),
      });
    }
  }

  /** (Re)point the zoom-FFT pipeline at the current view; resets the full-band
   *  analyzer so the next frame after a switch is clean. */
  private configureZoom() {
    this.zoom.configure(
      this.state.sampleRate,
      this.state.centerHz,
      this.state.spectrumView,
      this.state.spectrumAvg,
    );
    this.spectrum.reset();
  }

  /** Drop any zoom window (the band moved) and return to full-band frames. */
  private resetZoom() {
    if (this.state.spectrumView === null && !this.zoom.isActive) return;
    this.state.spectrumView = null;
    this.zoom.reset();
    this.spectrum.reset();
  }

  /** Tone-squelch verdict: open unless an NFM CTCSS/DCS requirement is unmet. */
  private toneSquelchOpen(): boolean {
    const want = this.state.toneSquelch;
    if (want == null || this.state.mode !== "NFM") return true;
    return this.demod.toneMatches(want);
  }

  private broadcastState() {
    this.sinks.json({ type: "state", state: this.state });
  }
}
