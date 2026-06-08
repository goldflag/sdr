// Radio: the single shared receiver. Owns the rtl_tcp process + client and the
// DSP chain (spectrum + demodulator), applies control messages, and emits JSON
// status and binary FFT/audio frames to be broadcast to all WebSocket clients.

import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  type ServerMessage,
  AUDIO_RATE,
  DEFAULT_BANDWIDTH,
  DEFAULT_STATE,
  TUNER_NAME,
  encodeAudioFrame,
  encodeFftFrame,
  gainStepsDb,
} from "@sdr/shared";
import { RtlTcpManager } from "./rtltcp/manager";
import { RtlTcpClient } from "./rtltcp/client";
import { SpectrumAnalyzer } from "./dsp/fft";
import { Demodulator } from "./dsp/demod";
import { Nco } from "./dsp/nco";
import { floatToInt16 } from "./dsp/resample";

const FFT_INTERVAL_MS = 50; // ~20 fps
const FFT_SIZE = 2048;

export interface RadioSinks {
  json: (msg: ServerMessage) => void;
  binary: (buf: ArrayBuffer) => void;
}

export class Radio {
  private manager: RtlTcpManager;
  private client: RtlTcpClient | null = null;
  private spectrum = new SpectrumAnalyzer(FFT_SIZE);
  private demod = new Demodulator();
  private vfo = new Nco(DEFAULT_STATE.sampleRate, 0);
  private deviceInfo: DeviceInfo | null = null;
  private state: RadioState = { ...DEFAULT_STATE };
  private lastFft = 0;
  private lastSignal = 0;
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
        break;
      case "setSampleRate":
        this.state.sampleRate = msg.hz;
        this.client?.setSampleRate(msg.hz);
        this.vfo.setSampleRate(msg.hz);
        this.reconfigureDemod();
        break;
      case "setMode":
        this.state.mode = msg.mode;
        this.state.bandwidth = DEFAULT_BANDWIDTH[msg.mode];
        this.reconfigureDemod();
        break;
      case "setBandwidth":
        this.state.bandwidth = msg.hz;
        this.reconfigureDemod();
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
        break;
    }
    this.broadcastState();
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
  }

  private reconfigureDemod() {
    this.demod.configure(
      this.state.mode as Mode,
      this.state.sampleRate,
      this.state.bandwidth,
    );
  }

  // --- IQ processing ---

  private onIq(iq: Float32Array) {
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
