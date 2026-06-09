// Wire protocol shared by the Bun server and the React client.
//
// - Control + status messages are JSON (ClientMessage / ServerMessage).
// - High-rate data (FFT frames, audio PCM) is sent as binary WebSocket frames
//   whose first byte is a BinaryFrameType tag. Encoders/decoders live here so
//   both ends agree on the exact byte layout.

// ---------------------------------------------------------------------------
// Demodulation modes
// ---------------------------------------------------------------------------

export const MODES = ["WFM", "NFM", "AM", "USB", "LSB", "CW"] as const;
export type Mode = (typeof MODES)[number];

/** Sensible default channel bandwidth (Hz) per mode. */
export const DEFAULT_BANDWIDTH: Record<Mode, number> = {
  WFM: 200_000,
  NFM: 12_500,
  AM: 10_000,
  USB: 2_700,
  LSB: 2_700,
  CW: 500,
};

/** Audio sample rate produced by the server demodulators. */
export const AUDIO_RATE = 48_000;

/** Centre audio pitch (Hz) of the CW passband, so a tuned carrier beats here. */
export const CW_TONE = 600;

/** Audio AGC speed presets (attack/decay/hang are baked into each). */
export const AGC_MODES = ["off", "fast", "medium", "slow"] as const;
export type AgcMode = (typeof AGC_MODES)[number];

/**
 * Default channel filter edges (Hz, relative to the tuned VFO) for a mode at a
 * given bandwidth. SSB is single-sided; CW sits around the CW beat tone; AM/FM
 * are symmetric. Edges can then be dragged independently (passband tuning).
 */
export function defaultEdges(mode: Mode, bw: number): [number, number] {
  switch (mode) {
    case "USB":
      return [0, bw];
    case "LSB":
      return [-bw, 0];
    case "CW":
      return [CW_TONE - bw / 2, CW_TONE + bw / 2];
    default:
      return [-bw / 2, bw / 2]; // WFM, NFM, AM
  }
}

/** ADS-B (Mode S extended squitter) operating point. */
export const ADSB_FREQ_HZ = 1_090_000_000;
export const ADSB_SAMPLE_RATE = 2_000_000; // 2 samples per Mode S bit

/**
 * AIS (marine traffic) operating point. The two AIS channels sit at 161.975 MHz
 * (A / 87B) and 162.025 MHz (B / 88B) — 50 kHz apart — so we centre between them
 * and capture both at once. 240 kSPS decimates by 5 to 48 kSPS (exactly 5
 * samples per 9600-baud GMSK symbol).
 */
export const AIS_FREQ_HZ = 162_000_000;
export const AIS_SAMPLE_RATE = 240_000;
/** Channel offsets from the AIS centre frequency, in Hz. */
export const AIS_CHANNELS = { A: -25_000, B: 25_000 } as const;

/** Direct-sampling mode values passed straight to rtl_tcp / librtlsdr. */
export const DIRECT_SAMPLING = {
  OFF: 0,
  I_BRANCH: 1,
  Q_BRANCH: 2, // RTL-SDR Blog V3 uses the Q branch for HF (< ~24 MHz)
} as const;
export type DirectSampling =
  (typeof DIRECT_SAMPLING)[keyof typeof DIRECT_SAMPLING];

// ---------------------------------------------------------------------------
// Tuner / gain tables
// ---------------------------------------------------------------------------

/** rtl_tcp tuner type ids (from the RTL0 dongle header). */
export enum TunerType {
  UNKNOWN = 0,
  E4000 = 1,
  FC0012 = 2,
  FC0013 = 3,
  FC2580 = 4,
  R820T = 5,
  R828D = 6,
}

export const TUNER_NAME: Record<number, string> = {
  0: "Unknown",
  1: "E4000",
  2: "FC0012",
  3: "FC0013",
  4: "FC2580",
  5: "R820T/R820T2",
  6: "R828D",
};

// Known R820T/R820T2 gain steps in tenths of a dB (the RTL-SDR V3 tuner).
// rtl_tcp's header reports only the *count* of gains, not their values, so we
// keep the canonical table here and select it by tuner type.
export const R820T_GAINS_TENTH_DB = [
  0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297,
  328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496,
] as const;

/** Returns gain steps in dB for a tuner type, or [] if unknown. */
export function gainStepsDb(tuner: number): number[] {
  if (tuner === TunerType.R820T || tuner === TunerType.R828D) {
    return R820T_GAINS_TENTH_DB.map((g) => g / 10);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** One channel the scanner can park on. */
export interface ScanEntry {
  hz: number;
  mode: Mode;
  bandwidth?: number;
  directSampling?: DirectSampling;
  label?: string;
}

/** Behaviour shared by both scan kinds. */
interface ScanCommon {
  /** Channel power (dB) above which a channel counts as active. */
  thresholdDb: number;
  /** How long to listen on a silent channel before stepping on (ms). */
  dwellMs: number;
  /** After a held signal drops, how long to wait before resuming (ms). */
  resumeMs: number;
}

export type ScanConfig =
  | ({ kind: "channels"; entries: ScanEntry[] } & ScanCommon)
  | ({
      kind: "range";
      startHz: number;
      stopHz: number;
      stepHz: number;
      mode: Mode;
      directSampling?: DirectSampling;
    } & ScanCommon);

/** Live scanner status pushed to clients. */
export interface ScanStatus {
  kind: "channels" | "range";
  index: number;
  total: number;
  currentHz: number;
  mode: Mode;
  /** True while parked on an active channel. */
  holding: boolean;
}

export const SCAN_DEFAULTS = {
  thresholdDb: -45,
  dwellMs: 250,
  resumeMs: 2000,
} as const;

// ---------------------------------------------------------------------------
// Client -> Server (JSON control)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "start" }
  | { type: "stop" }
  /** Dongle center frequency in Hz. */
  | { type: "setFrequency"; hz: number }
  /** Dongle sample rate in Hz (== captured bandwidth). */
  | { type: "setSampleRate"; hz: number }
  | { type: "setMode"; mode: Mode }
  /** Channel filter bandwidth in Hz (recentres the passband symmetrically). */
  | { type: "setBandwidth"; hz: number }
  /** Set the channel filter edges directly (passband tuning / IF shift), Hz from VFO. */
  | { type: "setPassband"; low: number; high: number }
  /** Audio noise reduction (LMS). */
  | { type: "setNr"; on: boolean; level?: number }
  /** Impulse noise blanker. */
  | { type: "setNb"; on: boolean; threshold?: number }
  /** Audio AGC speed. */
  | { type: "setAgc"; mode: AgcMode }
  /** Manual notch filters, as absolute RF frequencies in Hz. */
  | { type: "setNotches"; notches: number[] }
  /** Start scanning (channel list or range sweep). */
  | { type: "scanStart"; config: ScanConfig }
  | { type: "scanStop" }
  /** Force-advance to the next channel/step. */
  | { type: "scanSkip" }
  /** Gain control: auto AGC, or a manual gain in dB (snapped to a tuner step). */
  | { type: "setGain"; mode: "auto" | "manual"; db?: number }
  /** Squelch threshold in dB of channel power; null disables squelch. */
  | { type: "setSquelch"; db: number | null }
  | { type: "setPpm"; ppm: number }
  | { type: "setBiasTee"; on: boolean }
  | { type: "setDirectSampling"; value: DirectSampling }
  /** VFO offset from the dongle center frequency, in Hz (tune within the band). */
  | { type: "setVfoOffset"; hz: number }
  /** Toggle ADS-B mode: retunes to 1090 MHz @ 2 MSPS and decodes Mode S. */
  | { type: "setAdsb"; on: boolean }
  /** Receiver location for single-frame (local) CPR position decoding. */
  | { type: "setAdsbRef"; lat: number | null; lon: number | null }
  /** Toggle AIS mode: retunes to 162 MHz @ 240 kSPS and decodes both channels. */
  | { type: "setAis"; on: boolean };

// ---------------------------------------------------------------------------
// Server -> Client (JSON status)
// ---------------------------------------------------------------------------

/** One tracked aircraft from the ADS-B decoder. */
export interface AircraftReport {
  /** 24-bit ICAO address, lowercase hex. */
  icao: string;
  callsign?: string;
  /** Emitter category code, e.g. "A3" (large), "A7" (rotorcraft). */
  category?: string;
  altitude?: number; // feet (barometric)
  lat?: number;
  lon?: number;
  speed?: number; // ground speed, knots
  heading?: number; // track, degrees
  vertRate?: number; // ft/min
  rssi?: number; // signal level, dBFS
  messages: number;
  seen: number; // seconds since last message
}

/** One tracked vessel from the AIS decoder. */
export interface VesselReport {
  /** 9-digit Maritime Mobile Service Identity. */
  mmsi: string;
  name?: string;
  callsign?: string;
  /** Human-readable ship type, e.g. "Cargo", "Tanker", "Passenger". */
  shipType?: string;
  lat?: number;
  lon?: number;
  sog?: number; // speed over ground, knots
  cog?: number; // course over ground, degrees
  heading?: number; // true heading, degrees (undefined when not transmitted)
  navStatus?: string; // e.g. "Under way using engine"
  /** AIS channel the last message arrived on. */
  channel?: "A" | "B";
  rssi?: number; // signal level, dBFS
  /** True for Class B transponders (smaller craft), false/undefined for Class A. */
  classB?: boolean;
  messages: number;
  seen: number; // seconds since last message
}

export interface DeviceInfo {
  tuner: TunerType;
  tunerName: string;
  /** Available tuner gain steps in dB (empty if tuner unknown). */
  gains: number[];
}

export interface RadioState {
  running: boolean;
  centerHz: number;
  sampleRate: number;
  mode: Mode;
  bandwidth: number;
  /** Channel filter edges, Hz relative to the VFO (low < high). */
  filterLow: number;
  filterHigh: number;
  vfoOffset: number;
  gainMode: "auto" | "manual";
  gainDb: number;
  squelchDb: number | null;
  ppm: number;
  biasTee: boolean;
  directSampling: DirectSampling;
  /** Audio noise reduction. */
  nrOn: boolean;
  nrLevel: number; // 0..1
  /** Impulse noise blanker. */
  nbOn: boolean;
  nbThreshold: number; // spike threshold, × running mean
  /** Audio AGC speed. */
  agc: AgcMode;
  /** Manual notch filters, absolute RF frequencies in Hz. */
  notches: number[];
  /** When true the radio is decoding ADS-B (1090 MHz) instead of audio. */
  adsb: boolean;
  /** When true the radio is decoding AIS (162 MHz) instead of audio. */
  ais: boolean;
}

export type ServerMessage =
  | { type: "deviceInfo"; info: DeviceInfo }
  | { type: "state"; state: RadioState }
  /** Channel signal level in dB, for squelch UI / S-meter. */
  | { type: "signal"; channelDb: number; squelchOpen: boolean }
  /** Periodic ADS-B aircraft table snapshot (only while ADS-B is on). */
  | { type: "adsb"; aircraft: AircraftReport[]; messageRate: number }
  /**
   * Periodic AIS vessel table snapshot (only while AIS is on). `framesSeen` is
   * the running count of well-formed bursts the demod has found (valid or not)
   * — a reception/antenna activity gauge.
   */
  | {
      type: "ais";
      vessels: VesselReport[];
      messageRate: number;
      framesSeen: number;
    }
  /** Scanner status, or null when scanning stops. */
  | { type: "scan"; status: ScanStatus | null }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Binary frames (server -> client)
// ---------------------------------------------------------------------------

export enum BinaryFrameType {
  FFT = 0x01,
  AUDIO = 0x02,
}

// FFT frame layout (little-endian). The header is padded to 24 bytes so the
// trailing Float32Array starts on a 4/8-byte boundary (a typed-array view
// requires an aligned byte offset):
//   u8  type (=1)
//   u8  _pad[3]
//   f64 centerHz       dongle center frequency for this frame   @ offset 4
//   f64 sampleRate     span; bins cover [center-sr/2, center+sr/2)  @ offset 12
//   u32 binCount       @ offset 20
//   f32[binCount]      power in dB, low->high freq               @ offset 24
const FFT_HEADER_BYTES = 24;

export function encodeFftFrame(
  centerHz: number,
  sampleRate: number,
  binsDb: Float32Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(FFT_HEADER_BYTES + binsDb.length * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, BinaryFrameType.FFT);
  dv.setFloat64(4, centerHz, true);
  dv.setFloat64(12, sampleRate, true);
  dv.setUint32(20, binsDb.length, true);
  new Float32Array(buf, FFT_HEADER_BYTES).set(binsDb);
  return buf;
}

export interface FftFrame {
  centerHz: number;
  sampleRate: number;
  bins: Float32Array;
}

export function decodeFftFrame(buf: ArrayBuffer): FftFrame {
  const dv = new DataView(buf);
  const centerHz = dv.getFloat64(4, true);
  const sampleRate = dv.getFloat64(12, true);
  const binCount = dv.getUint32(20, true);
  const bins = new Float32Array(buf.slice(FFT_HEADER_BYTES)).subarray(
    0,
    binCount,
  );
  return { centerHz, sampleRate, bins };
}

// Audio frame layout (little-endian):
//   u8  type (=2)
//   u8  _pad
//   u32 sampleRate
//   int16[]  mono PCM samples
const AUDIO_HEADER_BYTES = 1 + 1 + 4;

export function encodeAudioFrame(
  sampleRate: number,
  pcm: Int16Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(AUDIO_HEADER_BYTES + pcm.length * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, BinaryFrameType.AUDIO);
  dv.setUint32(2, sampleRate, true);
  new Int16Array(buf, AUDIO_HEADER_BYTES).set(pcm);
  return buf;
}

export interface AudioFrame {
  sampleRate: number;
  pcm: Int16Array;
}

export function decodeAudioFrame(buf: ArrayBuffer): AudioFrame {
  const dv = new DataView(buf);
  const sampleRate = dv.getUint32(2, true);
  const pcm = new Int16Array(buf.slice(AUDIO_HEADER_BYTES));
  return { sampleRate, pcm };
}

/** Reads the leading tag byte of a binary frame. */
export function frameType(buf: ArrayBuffer): BinaryFrameType {
  return new DataView(buf).getUint8(0);
}

// ---------------------------------------------------------------------------
// Defaults / limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** RTL-SDR V3 usable range with direct sampling on the low end. */
  MIN_HZ: 500_000,
  MAX_HZ: 1_766_000_000,
  /** ~24 MHz: below this, direct sampling (Q branch) is required on the V3. */
  HF_THRESHOLD_HZ: 24_000_000,
  MIN_SAMPLE_RATE: 250_000,
  MAX_SAMPLE_RATE: 2_400_000,
} as const;

export const SAMPLE_RATES = [
  250_000, 1_024_000, 1_536_000, 2_048_000, 2_400_000,
] as const;

export const DEFAULT_STATE: RadioState = {
  running: false,
  centerHz: 100_300_000, // FM broadcast, a safe first tune
  sampleRate: 1_024_000,
  mode: "WFM",
  bandwidth: DEFAULT_BANDWIDTH.WFM,
  filterLow: -DEFAULT_BANDWIDTH.WFM / 2,
  filterHigh: DEFAULT_BANDWIDTH.WFM / 2,
  vfoOffset: 0,
  gainMode: "auto",
  gainDb: 0,
  squelchDb: null,
  ppm: 0,
  biasTee: false,
  directSampling: DIRECT_SAMPLING.OFF,
  nrOn: false,
  nrLevel: 0.5,
  nbOn: false,
  nbThreshold: 4,
  agc: "off",
  notches: [],
  adsb: false,
  ais: false,
};
