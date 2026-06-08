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

/** ADS-B (Mode S extended squitter) operating point. */
export const ADSB_FREQ_HZ = 1_090_000_000;
export const ADSB_SAMPLE_RATE = 2_000_000; // 2 samples per Mode S bit

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
  /** Channel filter bandwidth in Hz. */
  | { type: "setBandwidth"; hz: number }
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
  | { type: "setAdsb"; on: boolean };

// ---------------------------------------------------------------------------
// Server -> Client (JSON status)
// ---------------------------------------------------------------------------

/** One tracked aircraft from the ADS-B decoder. */
export interface AircraftReport {
  /** 24-bit ICAO address, lowercase hex. */
  icao: string;
  callsign?: string;
  altitude?: number; // feet (barometric)
  lat?: number;
  lon?: number;
  speed?: number; // ground speed, knots
  heading?: number; // track, degrees
  vertRate?: number; // ft/min
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
  vfoOffset: number;
  gainMode: "auto" | "manual";
  gainDb: number;
  squelchDb: number | null;
  ppm: number;
  biasTee: boolean;
  directSampling: DirectSampling;
  /** When true the radio is decoding ADS-B (1090 MHz) instead of audio. */
  adsb: boolean;
}

export type ServerMessage =
  | { type: "deviceInfo"; info: DeviceInfo }
  | { type: "state"; state: RadioState }
  /** Channel signal level in dB, for squelch UI / S-meter. */
  | { type: "signal"; channelDb: number; squelchOpen: boolean }
  /** Periodic ADS-B aircraft table snapshot (only while ADS-B is on). */
  | { type: "adsb"; aircraft: AircraftReport[]; messageRate: number }
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
  vfoOffset: 0,
  gainMode: "auto",
  gainDb: 0,
  squelchDb: null,
  ppm: 0,
  biasTee: false,
  directSampling: DIRECT_SAMPLING.OFF,
  adsb: false,
};
