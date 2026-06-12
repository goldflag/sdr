// Map decode layers (ADS-B / AIS / APRS), time-multiplexed. The single dongle
// can only tune one band at a time, so when several layers are enabled the
// scheduler round-robins the receiver across them: only the band the dongle is
// parked on decodes, while every enabled layer's accumulated targets stay on
// the map. Owns the three decode receivers and their broadcast cadences; tuning
// and state changes go through hooks back into the Radio.

import {
  type MapLayer,
  type RadioState,
  type ServerMessage,
  ADSB_FREQ_HZ,
  ADSB_SAMPLE_RATE,
  AIS_FREQ_HZ,
  AIS_SAMPLE_RATE,
  APRS_FREQ_HZ,
  APRS_IF_OFFSET,
  APRS_SAMPLE_RATE,
  DIRECT_SAMPLING,
} from "@sdr/shared";
import { AdsbReceiver } from "./dsp/adsb";
import { AisReceiver } from "./dsp/ais";
import { AprsReceiver } from "./dsp/aprs";

const ADSB_BROADCAST_MS = 1000; // aircraft table refresh rate
const AIS_BROADCAST_MS = 1000; // vessel table refresh rate
const APRS_BROADCAST_MS = 1000; // station table refresh rate
// When several map layers are enabled, the dongle round-robins across them.
const LAYER_DWELL_MS = 5000; // time spent on each band before rotating
const LAYER_SETTLE_MS = 300; // ignore IQ right after a retune (tuner transient)
const MAP_LAYERS: MapLayer[] = ["adsb", "ais", "aprs"];

/** Everything the scheduler needs from the Radio that owns it. */
export interface MapLayerHooks {
  /** The shared radio state (mutated in place, broadcast by the Radio). */
  state: RadioState;
  send(msg: ServerMessage): void;
  /** Push centre/rate/gain/direct-sampling to the device after a retune. */
  applyReceiver(): void;
  broadcastState(): void;
  saveDecodeState(): void;
  restoreDecodeState(): void;
  maxGain(): void;
  stopScan(): void;
  exitIsm(): void;
}

export class MapLayerScheduler {
  private adsb = new AdsbReceiver();
  private ais = new AisReceiver();
  private aprs = new AprsReceiver();
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private order: MapLayer[] = [];
  private current: MapLayer | null = null;
  private tuneAt = 0;
  private lastAdsb = 0;
  private lastAdsbCount = 0;
  private lastAis = 0;
  private lastAisCount = 0;
  private lastAprs = 0;
  private lastAprsCount = 0;

  constructor(private hooks: MapLayerHooks) {}

  /** Receiver location for single-frame (local) CPR position decoding. */
  setAdsbRef(lat: number | null, lon: number | null) {
    this.adsb.setRef(lat, lon);
  }

  /** Enable/disable a map layer, then reconcile the round-robin schedule. */
  setLayer(layer: MapLayer, on: boolean) {
    const { state } = this.hooks;
    if (state[layer] === on) return;
    if (on) this.hooks.exitIsm(); // map layers and ISM both need the dongle
    state[layer] = on;
    if (on) this.resetLayer(layer); // clear stale targets from a prior session
    this.reconcile();
  }

  /** Force every map layer off (releasing the dongle), e.g. to enter ISM. */
  disableAll() {
    const { state } = this.hooks;
    for (const l of MAP_LAYERS) state[l] = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active) {
      this.active = false;
      this.current = null;
      state.activeLayer = null;
      this.hooks.restoreDecodeState();
    }
  }

  /**
   * Decode + broadcast for the layer the dongle is parked on right now; the
   * other layers keep their accumulated targets until their next dwell. Returns
   * true when map mode consumed the block (including the post-retune settle),
   * false when no layer is active and normal processing should continue.
   */
  processIq(iq: Float32Array, now: number): boolean {
    if (!this.current) return false;
    // Skip the first samples after a retune while the tuner settles.
    if (now - this.tuneAt < LAYER_SETTLE_MS) return true;
    if (this.current === "adsb") {
      this.adsb.process(iq);
      if (now - this.lastAdsb >= ADSB_BROADCAST_MS) {
        const total = this.adsb.totalMessages;
        const rate = this.lastAdsb
          ? (total - this.lastAdsbCount) / ((now - this.lastAdsb) / 1000)
          : 0;
        this.lastAdsb = now;
        this.lastAdsbCount = total;
        this.hooks.send({
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
        this.hooks.send({
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
        this.hooks.send({
          type: "aprs",
          stations: this.aprs.snapshot(now),
          messageRate: Math.round(rate),
          framesSeen: this.aprs.candidateFrames,
        });
      }
    }
    return true;
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
    const s = this.hooks.state;
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
    this.hooks.applyReceiver();
  }

  /** Start/stop/retime the dongle to cover exactly the enabled layers. */
  private reconcile() {
    const { state } = this.hooks;
    const enabled = MAP_LAYERS.filter((l) => state[l]);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (enabled.length === 0) {
      if (this.active) {
        this.active = false;
        this.current = null;
        state.activeLayer = null;
        this.hooks.restoreDecodeState();
        this.hooks.applyReceiver();
      }
      return;
    }
    this.hooks.stopScan();
    if (!this.active) {
      this.active = true;
      this.hooks.saveDecodeState();
      this.hooks.maxGain();
    }
    this.order = enabled;
    // Keep dwelling on the current band if it's still enabled, else start over.
    if (!this.current || !enabled.includes(this.current)) {
      this.tuneLayer(enabled[0]!);
    }
    // Only round-robin when more than one band is enabled (else full duty).
    if (enabled.length > 1) {
      this.timer = setInterval(() => this.rotate(), LAYER_DWELL_MS);
    }
  }

  private rotate() {
    if (!this.hooks.state.running) return; // don't thrash a stopped/disconnected tuner
    const order = this.order;
    if (order.length < 2) return;
    const i = (order.indexOf(this.current as MapLayer) + 1) % order.length;
    this.tuneLayer(order[i]!);
    this.hooks.broadcastState();
  }
}
