// Radio: the single shared receiver. Owns the rtl_tcp process + client and the
// DSP chain (spectrum + demodulator), applies control messages, and emits JSON
// status and binary FFT/audio frames to be broadcast to all WebSocket clients.

import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  type ScanEntry,
  type ServerMessage,
  ADSB_FREQ_HZ,
  ADSB_SAMPLE_RATE,
  AIS_FREQ_HZ,
  AIS_SAMPLE_RATE,
  APRS_FREQ_HZ,
  APRS_IF_OFFSET,
  APRS_SAMPLE_RATE,
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
import { RtlTcpManager } from "./rtltcp/manager";
import { RtlTcpClient } from "./rtltcp/client";
import { SpectrumAnalyzer } from "./dsp/fft";
import { Demodulator } from "./dsp/demod";
import { AdsbReceiver } from "./dsp/adsb";
import { AisReceiver } from "./dsp/ais";
import { AprsReceiver } from "./dsp/aprs";
import { IsmReceiver } from "./dsp/ism";
import { Nco } from "./dsp/nco";
import { floatToInt16 } from "./dsp/resample";
import { Scanner } from "./scanner";

const FFT_INTERVAL_MS = 50; // ~20 fps
const FFT_SIZE = 2048;
const ADSB_BROADCAST_MS = 1000; // aircraft table refresh rate
const AIS_BROADCAST_MS = 1000; // vessel table refresh rate
const APRS_BROADCAST_MS = 1000; // station table refresh rate
const ISM_BROADCAST_MS = 500; // ISM event log refresh rate

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
  private manager: RtlTcpManager;
  private client: RtlTcpClient | null = null;
  private spectrum = new SpectrumAnalyzer(FFT_SIZE);
  private demod = new Demodulator();
  private adsb = new AdsbReceiver();
  private ais = new AisReceiver();
  private aprs = new AprsReceiver();
  private ism = new IsmReceiver();
  private scanner = new Scanner({
    tune: (e) => this.scanTune(e),
    status: (s) => {
      this.scanHolding = s?.holding ?? false;
      this.sinks.json({ type: "scan", status: s });
    },
  });
  private scanHolding = false;
  private vfo = new Nco(DEFAULT_STATE.sampleRate, 0);
  private deviceInfo: DeviceInfo | null = null;
  private state: RadioState = { ...DEFAULT_STATE };
  private lastFft = 0;
  private lastSignal = 0;
  private lastAdsb = 0;
  private lastAdsbCount = 0;
  private lastAis = 0;
  private lastAisCount = 0;
  private lastAprs = 0;
  private lastAprsCount = 0;
  private lastIsm = 0;
  // Receiver settings saved when entering a decode mode (ADS-B / AIS), restored
  // on exit.
  private preDecode: Pick<
    RadioState,
    "centerHz" | "sampleRate" | "gainMode" | "gainDb" | "directSampling"
  > | null = null;
  private starting = false;
  private stopping = false;

  constructor(private sinks: RadioSinks) {
    this.manager = new RtlTcpManager();
    this.manager.on((e) => {
      if (e.type === "log") console.log(`[rtl_tcp] ${e.line}`);
      else if (e.type === "exit") {
        this.client?.close();
        this.client = null;
        this.deviceInfo = null;
        this.state.running = false;
        this.starting = false;
        // Don't surface an error for a stop we initiated (e.g. last client left).
        if (!this.stopping) {
          this.sinks.json({ type: "error", message: e.reason });
        }
        this.stopping = false;
        this.broadcastState();
      }
    });
  }

  getState(): RadioState {
    return this.state;
  }
  getDeviceInfo(): DeviceInfo | null {
    return this.deviceInfo;
  }

  async start() {
    if (this.state.running || this.starting) return;
    this.starting = true;
    await this.manager.start();
    // rtl_tcp logs "listening..." to block-buffered stdout, so we don't wait
    // for it — just connect, retrying until the TCP socket accepts.
    await this.connectClient();
  }

  stop() {
    this.stopping = true;
    this.client?.close();
    this.client = null;
    this.manager.stop();
    this.state.running = false;
    this.starting = false;
    this.deviceInfo = null;
    this.broadcastState();
  }

  private async connectClient() {
    const client = new RtlTcpClient({
      host: this.manager.host,
      port: this.manager.port,
    });
    client.onHeader((h) => {
      this.deviceInfo = {
        tuner: h.tuner,
        tunerName: TUNER_NAME[h.tuner] ?? `tuner ${h.tuner}`,
        gains: gainStepsDb(h.tuner),
      };
      this.sinks.json({ type: "deviceInfo", info: this.deviceInfo });
      this.applyAll();
      this.state.running = true;
      this.starting = false;
      this.broadcastState();
    });
    client.onIq((iq) => this.onIq(iq));
    client.onError((msg) => this.sinks.json({ type: "error", message: msg }));
    client.onClose(() => {
      this.state.running = false;
      this.broadcastState();
    });
    try {
      await client.connect();
      this.client = client;
    } catch (err) {
      this.starting = false;
      this.sinks.json({ type: "error", message: (err as Error).message });
    }
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
        break;
      case "setSampleRate":
        this.state.sampleRate = msg.hz;
        this.client?.setSampleRate(msg.hz);
        this.vfo.setSampleRate(msg.hz);
        this.reconfigureDemod();
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
        break;
      case "setAdsb":
        if (msg.on) this.enterAdsb();
        else this.exitAdsb();
        break;
      case "setAdsbRef":
        this.adsb.setRef(msg.lat, msg.lon);
        break;
      case "setAis":
        if (msg.on) this.enterAis();
        else this.exitAis();
        break;
      case "setAprs":
        if (msg.on) this.enterAprs();
        else this.exitAprs();
        break;
      case "setIsm":
        if (msg.on) this.enterIsm();
        else this.exitIsm();
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

  /** Tune to max gain (digital decode modes are reception-limited). */
  private maxGain() {
    const gains = this.deviceInfo?.gains ?? [];
    if (gains.length > 0) {
      this.state.gainMode = "manual";
      this.state.gainDb = gains[gains.length - 1]!;
    }
  }

  /** Retune to 1090 MHz @ 2 MSPS with max gain and start Mode S decoding. */
  private enterAdsb() {
    if (this.state.adsb) return;
    this.exitDecoders(); // the dongle can only listen on one band at a time
    this.scanner.stop();
    this.saveDecodeState();
    const s = this.state;
    s.adsb = true;
    s.centerHz = ADSB_FREQ_HZ;
    s.sampleRate = ADSB_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    this.maxGain();
    this.adsb.reset();
    this.lastAdsb = 0;
    this.lastAdsbCount = 0;
    this.applyReceiver();
  }

  /** Leave ADS-B and restore the previous receiver settings. */
  private exitAdsb() {
    if (!this.state.adsb) return;
    this.state.adsb = false;
    this.restoreDecodeState();
    this.applyReceiver();
  }

  /** Retune to 162 MHz @ 240 kSPS with max gain and start AIS decoding. */
  private enterAis() {
    if (this.state.ais) return;
    this.exitDecoders(); // mutually exclusive with the other decode modes
    this.scanner.stop();
    this.saveDecodeState();
    const s = this.state;
    s.ais = true;
    s.centerHz = AIS_FREQ_HZ;
    s.sampleRate = AIS_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    this.maxGain();
    this.ais.reset();
    this.lastAis = 0;
    this.lastAisCount = 0;
    this.applyReceiver();
  }

  /** Leave AIS and restore the previous receiver settings. */
  private exitAis() {
    if (!this.state.ais) return;
    this.state.ais = false;
    this.restoreDecodeState();
    this.applyReceiver();
  }

  /** Retune to 144.39 MHz and start AFSK/AX.25 APRS decoding. */
  private enterAprs() {
    if (this.state.aprs) return;
    this.exitDecoders();
    this.scanner.stop();
    this.saveDecodeState();
    const s = this.state;
    s.aprs = true;
    // Tune below the channel so the FM carrier clears the centre DC spike.
    s.centerHz = APRS_FREQ_HZ - APRS_IF_OFFSET;
    s.sampleRate = APRS_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    this.maxGain();
    this.aprs.reset();
    this.lastAprs = 0;
    this.lastAprsCount = 0;
    this.applyReceiver();
  }

  /** Leave APRS and restore the previous receiver settings. */
  private exitAprs() {
    if (!this.state.aprs) return;
    this.state.aprs = false;
    this.restoreDecodeState();
    this.applyReceiver();
  }

  /** Retune to the selected ISM band @ 250 kSPS and start OOK decoding. */
  private enterIsm() {
    if (this.state.ism) return;
    this.exitDecoders();
    this.scanner.stop();
    this.saveDecodeState();
    const s = this.state;
    s.ism = true;
    s.centerHz = s.ismFreqHz;
    s.sampleRate = ISM_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    this.maxGain();
    this.ism.reset();
    this.lastIsm = 0;
    this.applyReceiver();
  }

  /** Leave ISM and restore the previous receiver settings. */
  private exitIsm() {
    if (!this.state.ism) return;
    this.state.ism = false;
    this.restoreDecodeState();
    this.applyReceiver();
  }

  /** Leave whichever decode mode is active (they're mutually exclusive). */
  private exitDecoders() {
    this.exitAdsb();
    this.exitAis();
    this.exitAprs();
    this.exitIsm();
  }

  /** Push center freq / sample rate / gain / direct sampling to the device. */
  private applyReceiver() {
    const s = this.state;
    const c = this.client;
    this.vfo.setSampleRate(s.sampleRate);
    this.vfo.setFreq(-s.vfoOffset);
    this.reconfigureDemod();
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
    if (e.directSampling !== undefined && e.directSampling !== s.directSampling) {
      s.directSampling = e.directSampling;
      this.client?.setDirectSampling(e.directSampling);
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
    this.broadcastState();
  }

  // --- IQ processing ---

  private onIq(iq: Float32Array) {
    if (this.state.adsb) {
      this.adsb.process(iq);
      const now = Date.now();
      if (now - this.lastAdsb >= ADSB_BROADCAST_MS) {
        const total = this.adsb.totalMessages;
        const rate = this.lastAdsb
          ? (total - this.lastAdsbCount) / ((now - this.lastAdsb) / 1000)
          : 0;
        this.lastAdsb = now;
        this.lastAdsbCount = total;
        this.sinks.json({
          type: "adsb",
          aircraft: this.adsb.snapshot(now),
          messageRate: Math.round(rate),
        });
      }
      return;
    }

    if (this.state.ais) {
      this.ais.process(iq);
      const now = Date.now();
      if (now - this.lastAis >= AIS_BROADCAST_MS) {
        const total = this.ais.totalMessages;
        const rate = this.lastAis
          ? (total - this.lastAisCount) / ((now - this.lastAis) / 1000)
          : 0;
        this.lastAis = now;
        this.lastAisCount = total;
        this.sinks.json({
          type: "ais",
          vessels: this.ais.snapshot(now),
          messageRate: Math.round(rate),
          framesSeen: this.ais.candidateFrames,
        });
      }
      return;
    }

    if (this.state.aprs) {
      this.aprs.process(iq);
      const now = Date.now();
      if (now - this.lastAprs >= APRS_BROADCAST_MS) {
        const total = this.aprs.totalMessages;
        const rate = this.lastAprs
          ? (total - this.lastAprsCount) / ((now - this.lastAprs) / 1000)
          : 0;
        this.lastAprs = now;
        this.lastAprsCount = total;
        this.sinks.json({
          type: "aprs",
          stations: this.aprs.snapshot(now),
          messageRate: Math.round(rate),
          framesSeen: this.aprs.candidateFrames,
        });
      }
      return;
    }

    if (this.state.ism) {
      this.ism.process(iq);
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

    // Spectrum sees the whole captured band (unshifted).
    this.spectrum.push(iq);
    const now = Date.now();
    if (now - this.lastFft >= FFT_INTERVAL_MS) {
      const bins = this.spectrum.getFrame();
      if (bins) {
        this.lastFft = now;
        this.sinks.binary(
          encodeFftFrame(this.state.centerHz, this.state.sampleRate, bins),
        );
      }
    }

    // Demod path: shift the VFO to DC on a copy, then demodulate.
    const shifted = this.vfo.mix(iq, new Float32Array(iq.length));
    const { audio, powerDb } = this.demod.process(shifted);

    // Drive the scanner with the live channel power.
    if (this.scanner.active) this.scanner.onPower(powerDb, now);

    const squelch = this.state.squelchDb;
    const squelchOpen = squelch == null || powerDb >= squelch;
    // While scanning, only pass audio once parked on an active channel, so we
    // don't blast noise from every silent channel we step across.
    const open = squelchOpen && (!this.scanner.active || this.scanHolding);
    if (audio.length > 0 && open) {
      this.sinks.binary(encodeAudioFrame(AUDIO_RATE, floatToInt16(audio)));
    }
    if (now - this.lastSignal >= 100) {
      this.lastSignal = now;
      this.sinks.json({
        type: "signal",
        channelDb: powerDb,
        squelchOpen: squelchOpen,
      });
    }
  }

  private broadcastState() {
    this.sinks.json({ type: "state", state: this.state });
  }
}
