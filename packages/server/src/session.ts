// Radio: the single shared receiver. Owns the rtl_tcp process + client and the
// DSP chain (spectrum + demodulator), applies control messages, and emits JSON
// status and binary FFT/audio frames to be broadcast to all WebSocket clients.

import {
  type ClientMessage,
  type DeviceInfo,
  type MapLayer,
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
const RDS_BROADCAST_MS = 1000; // RDS station refresh rate (WFM only)
// When several map layers are enabled, the dongle round-robins across them.
const LAYER_DWELL_MS = 5000; // time spent on each band before rotating
const LAYER_SETTLE_MS = 300; // ignore IQ right after a retune (tuner transient)
const MAP_LAYERS: MapLayer[] = ["adsb", "ais", "aprs"];

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
  private lastRds = 0;
  // Round-robin scheduler for the map decode layers.
  private mapActive = false;
  private mapTimer: ReturnType<typeof setInterval> | null = null;
  private mapOrder: MapLayer[] = [];
  private current: MapLayer | null = null;
  private tuneAt = 0;
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
        this.demod.resetRds(); // different station — drop the old RDS data
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
        this.demod.resetRds(); // tuned to a different station within the band
        break;
      case "setAdsb":
        this.setLayer("adsb", msg.on);
        break;
      case "setAdsbRef":
        this.adsb.setRef(msg.lat, msg.lon);
        break;
      case "setAis":
        this.setLayer("ais", msg.on);
        break;
      case "setAprs":
        this.setLayer("aprs", msg.on);
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

  // --- map decode layers (ADS-B / AIS / APRS, time-multiplexed) -----------

  /** Enable/disable a map layer, then reconcile the round-robin schedule. */
  private setLayer(layer: MapLayer, on: boolean) {
    if (this.state[layer] === on) return;
    if (on) this.exitIsm(); // map layers and ISM both need the dongle
    this.state[layer] = on;
    if (on) this.resetLayer(layer); // clear stale targets from a prior session
    this.reconcileLayers();
  }

  private resetLayer(layer: MapLayer) {
    if (layer === "adsb") {
      this.adsb.reset();
      this.lastAdsb = 0;
      this.lastAdsbCount = 0;
    } else if (layer === "ais") {
      this.ais.reset();
      this.lastAis = 0;
      this.lastAisCount = 0;
    } else {
      this.aprs.reset();
      this.lastAprs = 0;
      this.lastAprsCount = 0;
    }
  }

  /** Centre/rate the dongle for one layer and mark it the active one. */
  private tuneLayer(layer: MapLayer) {
    const s = this.state;
    s.directSampling = DIRECT_SAMPLING.OFF;
    if (layer === "adsb") {
      s.centerHz = ADSB_FREQ_HZ;
      s.sampleRate = ADSB_SAMPLE_RATE;
    } else if (layer === "ais") {
      s.centerHz = AIS_FREQ_HZ;
      s.sampleRate = AIS_SAMPLE_RATE;
    } else {
      // Tune below the channel so the FM carrier clears the centre DC spike.
      s.centerHz = APRS_FREQ_HZ - APRS_IF_OFFSET;
      s.sampleRate = APRS_SAMPLE_RATE;
    }
    this.current = layer;
    s.activeLayer = layer;
    this.tuneAt = Date.now();
    this.applyReceiver();
  }

  /** Start/stop/retime the dongle to cover exactly the enabled layers. */
  private reconcileLayers() {
    const enabled = MAP_LAYERS.filter((l) => this.state[l]);
    if (this.mapTimer) {
      clearInterval(this.mapTimer);
      this.mapTimer = null;
    }
    if (enabled.length === 0) {
      if (this.mapActive) {
        this.mapActive = false;
        this.current = null;
        this.state.activeLayer = null;
        this.restoreDecodeState();
        this.applyReceiver();
      }
      return;
    }
    this.scanner.stop();
    if (!this.mapActive) {
      this.mapActive = true;
      this.saveDecodeState();
      this.maxGain();
    }
    this.mapOrder = enabled;
    // Keep dwelling on the current band if it's still enabled, else start over.
    if (!this.current || !enabled.includes(this.current)) {
      this.tuneLayer(enabled[0]!);
    }
    // Only round-robin when more than one band is enabled (else full duty).
    if (enabled.length > 1) {
      this.mapTimer = setInterval(() => this.rotateLayer(), LAYER_DWELL_MS);
    }
  }

  private rotateLayer() {
    if (!this.state.running) return; // don't thrash a stopped/disconnected tuner
    const order = this.mapOrder;
    if (order.length < 2) return;
    const i = (order.indexOf(this.current as MapLayer) + 1) % order.length;
    this.tuneLayer(order[i]!);
    this.broadcastState();
  }

  /** Force every map layer off (releasing the dongle), e.g. to enter ISM. */
  private disableAllLayers() {
    for (const l of MAP_LAYERS) this.state[l] = false;
    if (this.mapTimer) {
      clearInterval(this.mapTimer);
      this.mapTimer = null;
    }
    if (this.mapActive) {
      this.mapActive = false;
      this.current = null;
      this.state.activeLayer = null;
      this.restoreDecodeState();
    }
  }

  /** Retune to the selected ISM band @ 250 kSPS and start OOK decoding. */
  private enterIsm() {
    if (this.state.ism) return;
    this.disableAllLayers(); // release the dongle from map mode
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
    this.broadcastState();
  }

  // --- IQ processing ---

  private onIq(iq: Float32Array) {
    // Map layers: only the band the dongle is parked on right now decodes; the
    // others keep their accumulated targets until their next dwell. Skip the
    // first samples after a retune while the tuner settles.
    if (this.current) {
      const now = Date.now();
      if (now - this.tuneAt < LAYER_SETTLE_MS) return;
      if (this.current === "adsb") {
        this.adsb.process(iq);
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
      } else if (this.current === "ais") {
        this.ais.process(iq);
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
      } else {
        this.aprs.process(iq);
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

  private broadcastState() {
    this.sinks.json({ type: "state", state: this.state });
  }
}
