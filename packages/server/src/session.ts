// Radio: the single shared receiver. Owns the rtl_tcp process + client and the
// DSP chain (spectrum + demodulator), applies control messages, and emits JSON
// status and binary FFT/audio frames to be broadcast to all WebSocket clients.

import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  type ServerMessage,
  ADSB_FREQ_HZ,
  ADSB_SAMPLE_RATE,
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
import { Nco } from "./dsp/nco";
import { floatToInt16 } from "./dsp/resample";

const FFT_INTERVAL_MS = 50; // ~20 fps
const FFT_SIZE = 2048;
const ADSB_BROADCAST_MS = 1000; // aircraft table refresh rate

export interface RadioSinks {
  json: (msg: ServerMessage) => void;
  binary: (buf: ArrayBuffer) => void;
}

export class Radio {
  private manager: RtlTcpManager;
  private client: RtlTcpClient | null = null;
  private spectrum = new SpectrumAnalyzer(FFT_SIZE);
  private demod = new Demodulator();
  private adsb = new AdsbReceiver();
  private vfo = new Nco(DEFAULT_STATE.sampleRate, 0);
  private deviceInfo: DeviceInfo | null = null;
  private state: RadioState = { ...DEFAULT_STATE };
  private lastFft = 0;
  private lastSignal = 0;
  private lastAdsb = 0;
  private lastAdsbCount = 0;
  // Receiver settings saved when entering ADS-B, restored on exit.
  private preAdsb: Pick<
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
    }
    this.broadcastState();
  }

  /** Retune to 1090 MHz @ 2 MSPS with max gain and start Mode S decoding. */
  private enterAdsb() {
    if (this.state.adsb) return;
    const s = this.state;
    this.preAdsb = {
      centerHz: s.centerHz,
      sampleRate: s.sampleRate,
      gainMode: s.gainMode,
      gainDb: s.gainDb,
      directSampling: s.directSampling,
    };
    s.adsb = true;
    s.centerHz = ADSB_FREQ_HZ;
    s.sampleRate = ADSB_SAMPLE_RATE;
    s.directSampling = DIRECT_SAMPLING.OFF;
    // ADS-B decodes best near max gain.
    const gains = this.deviceInfo?.gains ?? [];
    if (gains.length > 0) {
      s.gainMode = "manual";
      s.gainDb = gains[gains.length - 1]!;
    }
    this.adsb.reset();
    this.lastAdsb = 0;
    this.lastAdsbCount = 0;
    this.applyReceiver();
  }

  /** Leave ADS-B and restore the previous receiver settings. */
  private exitAdsb() {
    if (!this.state.adsb) return;
    const s = this.state;
    s.adsb = false;
    if (this.preAdsb) {
      s.centerHz = this.preAdsb.centerHz;
      s.sampleRate = this.preAdsb.sampleRate;
      s.gainMode = this.preAdsb.gainMode;
      s.gainDb = this.preAdsb.gainDb;
      s.directSampling = this.preAdsb.directSampling;
      this.preAdsb = null;
    }
    this.applyReceiver();
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

    const squelch = this.state.squelchDb;
    const open = squelch == null || powerDb >= squelch;
    if (audio.length > 0 && open) {
      this.sinks.binary(encodeAudioFrame(AUDIO_RATE, floatToInt16(audio)));
    }
    if (now - this.lastSignal >= 100) {
      this.lastSignal = now;
      this.sinks.json({ type: "signal", channelDb: powerDb, squelchOpen: open });
    }
  }

  private broadcastState() {
    this.sinks.json({ type: "state", state: this.state });
  }
}
