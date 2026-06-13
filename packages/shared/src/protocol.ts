// Wire protocol shared by the Bun server and the React client.
//
// - Control + status messages are JSON (ClientMessage / ServerMessage).
// - High-rate data (FFT frames, audio PCM) is sent as binary WebSocket frames
//   whose first byte is a BinaryFrameType tag. Encoders/decoders live here so
//   both ends agree on the exact byte layout.

/**
 * Bumped on any breaking change to the JSON messages or binary frame layouts.
 * The server announces its version in a `hello` message on connect; a client
 * built against a different version shows a "reload the page" error instead of
 * silently misdecoding frames (e.g. a stale tab open across a server upgrade).
 */
export const PROTOCOL_VERSION = 1;

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
 * Sub-audible tone selector (NFM): a CTCSS tone or a DCS code. Used both as
 * the required tone-squelch setting and as the decoder's detection report.
 */
export type ToneSquelch =
  | { kind: "ctcss"; hz: number }
  | { kind: "dcs"; code: number; inverted: boolean };

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

/**
 * APRS (Automatic Packet Reporting System) operating point. In North America
 * APRS lives on 144.390 MHz: 1200-baud Bell-202 AFSK (1200/2200 Hz tones) inside
 * an NBFM channel, carrying AX.25 UI frames. We capture at 240 kSPS and decimate
 * by 5 to 48 kHz (40 samples per 1200-baud symbol).
 */
export const APRS_FREQ_HZ = 144_390_000;
export const APRS_SAMPLE_RATE = 240_000;
/**
 * Tune the dongle this far below the APRS channel so the FM carrier sits clear
 * of the RTL's centre DC spike; the receiver mixes it back down to baseband.
 */
export const APRS_IF_OFFSET = 30_000;

/**
 * ISM band OOK/ASK decode (rtl_433-style). 433.92 MHz is the busiest band for
 * cheap sensors/remotes in most of the world; 315 MHz is common in North
 * America. 250 kSPS gives ~4 µs pulse-timing resolution, matching rtl_433's
 * default and comfortably resolving the ~250 µs–2 ms pulses these devices use.
 */
export const ISM_FREQ_HZ = 433_920_000;
export const ISM_SAMPLE_RATE = 250_000;
/** Quick-pick ISM centre frequencies (Hz), with labels. */
export const ISM_BANDS = [
  { hz: 315_000_000, label: "315" },
  { hz: 433_920_000, label: "434" },
  { hz: 868_300_000, label: "868" },
  { hz: 915_000_000, label: "915" },
] as const;

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
  /** Require a CTCSS tone / DCS code to open the squelch (NFM); null disables. */
  | { type: "setToneSquelch"; tone: ToneSquelch | null }
  /** Spectrum cross-frame averaging strength, 0 (off) .. 1 (very slow). */
  | { type: "setSpectrumAvg"; level: number }
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
  | { type: "setAis"; on: boolean }
  /** Toggle APRS mode: retunes to 144.39 MHz and decodes AX.25 AFSK packets. */
  | { type: "setAprs"; on: boolean }
  /** Toggle ISM (rtl_433-style) OOK decode at the current ISM frequency. */
  | { type: "setIsm"; on: boolean }
  /** Set the ISM centre frequency in Hz (315 / 434 / 868 / 915 MHz, …). */
  | { type: "setIsmFreq"; hz: number }
  /** Toggle live speech-to-text of the demodulated audio (via whisper.cpp). */
  | { type: "setTranscribe"; on: boolean }
  /** Pick the whisper model by name (must be one of state.transcribeModels). */
  | { type: "setTranscribeModel"; model: string };

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

/**
 * Map decode layers. The single dongle can only tune one band at a time, so when
 * several are enabled the receiver round-robins across them; the map shows every
 * enabled layer's accumulated targets together.
 */
export type MapLayer = "adsb" | "ais" | "aprs";

/** One APRS station/object decoded from an AX.25 UI frame. */
export interface StationReport {
  /** Source callsign with SSID, e.g. "N0CALL-9". */
  call: string;
  lat?: number;
  lon?: number;
  course?: number; // degrees true
  speed?: number; // knots
  altitude?: number; // feet
  /** APRS symbol as table+code, e.g. "/>" (car) or "/_" (weather). */
  symbol?: string;
  /** Free-text comment / status text. */
  comment?: string;
  /** Digipeater path the last packet travelled, e.g. "WIDE1-1,WIDE2-1". */
  via?: string;
  /** Packet category: "position" | "mic-e" | "object" | "status" | "message" | "other". */
  kind?: string;
  /** Last message addressed *to* another station (for message packets). */
  message?: string;
  packets: number;
  seen: number; // seconds since last packet
}

/** One decoded (or raw) ISM-band OOK transmission. */
export interface IsmEvent {
  /** Monotonic id so the client can append only what it hasn't seen. */
  id: number;
  /** Server epoch milliseconds when the burst completed. */
  time: number;
  /** Decoder/device model, e.g. "EV1527" or "OOK" for an undecoded burst. */
  model: string;
  /** Line coding, e.g. "PWM". */
  protocol: string;
  /** Decoded bit count. */
  bits: number;
  /** Decoded payload as hex. */
  code: string;
  /** Device id (hex) when the protocol exposes one. */
  deviceId?: string;
  /** Human-readable decoded fields, e.g. "button 0x8". */
  data?: string;
  /** Sub-channel label (A/B/C or 0–2) when the device exposes one. */
  channel?: string;
  /** Temperature in °C, for decoded weather sensors. */
  tempC?: number;
  /** Relative humidity %, for decoded weather sensors. */
  humidityPct?: number;
  /** True when the device reports a low battery. */
  batteryLow?: boolean;
  /** Wind speed in km/h, for weather stations that report it. */
  windSpeedKmh?: number;
  /** Wind direction in degrees (0 = N, clockwise). */
  windDirDeg?: number;
  /** Cumulative rain in mm (the running total the sensor reports). */
  rainMm?: number;
  /** Barometric pressure in hPa. */
  pressureHpa?: number;
  /** Tyre pressure in kPa, for TPMS sensors. */
  pressureKpa?: number;
  /** How many times this identical packet repeated within the burst. */
  repeats: number;
  /** Burst signal level, dB above the noise floor. */
  snrDb: number;
}

/**
 * Lifecycle of the transcription engine. `loading` while the whisper child
 * loads its model (seconds); `lagging` when inference can't keep up with live
 * audio and old chunks are being dropped; `failed` when the child couldn't
 * start (or died repeatedly) — the panel surfaces each so a silent transcript
 * is explainable.
 */
export const TRANSCRIBE_STATUSES = [
  "off",
  "loading",
  "ready",
  "lagging",
  "failed",
] as const;
export type TranscribeStatus = (typeof TRANSCRIBE_STATUSES)[number];

/**
 * One transcribed chunk of demodulated audio (speech-to-text via whisper.cpp).
 *
 * While an utterance is still being spoken the server emits it as a live
 * preview (`final: false`) that is re-issued with the same `id` and longer
 * text every couple of seconds; once the utterance completes, a `final: true`
 * segment with the same `id` replaces it. A final segment with empty `text`
 * is a tombstone: the preview turned out to be nothing usable (silence,
 * music, low confidence) and the client should remove that id.
 */
export interface TranscriptSegment {
  /** Monotonic id so clients can merge batches idempotently. */
  id: number;
  /** Server epoch milliseconds when the audio chunk ended. */
  time: number;
  /** Transcribed text (trimmed; empty only on a final tombstone). */
  text: string;
  /** Tuned frequency (Hz) the audio was received on. */
  freqHz: number;
  /** Length of the transcribed audio, in seconds. */
  durationS: number;
  /** False while this is a live, still-refining preview of an open utterance. */
  final: boolean;
}

/** A broadcast-FM clock-time (RDS group 4A). */
export interface RdsClockTime {
  /** Local time the station broadcast, ISO 8601 with offset (e.g. "2026-06-09T14:30-05:00"). */
  iso: string;
  /** UTC epoch milliseconds of that minute. */
  epoch: number;
}

/**
 * Decoded RDS (Radio Data System / RBDS) information for the FM station the
 * receiver is tuned to. Fields fill in as groups arrive — PI almost immediately,
 * the 8-char Programme Service name and 64-char RadioText over a few seconds.
 */
export interface RdsStation {
  /** Programme Identification code, 16-bit, hex (e.g. "54C4"). */
  pi: string;
  /** Call sign derived from PI via the RBDS (North America) algorithm, when decodable. */
  callSign?: string;
  /** Programme Service name, up to 8 characters. */
  ps?: string;
  /** RadioText, up to 64 characters. */
  radioText?: string;
  /** Programme TYpe code, 0–31. */
  pty?: number;
  /** Programme Type name (RBDS table). */
  ptyName?: string;
  /** Traffic Programme flag — the station carries traffic announcements. */
  tp?: boolean;
  /** Traffic Announcement in progress right now. */
  ta?: boolean;
  /** Programme is music (true) or speech (false). */
  music?: boolean;
  /** Stereo broadcast (decoder-identification bit). */
  stereo?: boolean;
  /** Alternative frequencies for this programme, in MHz. */
  altFreqs?: number[];
  /** Most recent clock-time (group 4A). */
  clock?: RdsClockTime;
}

/** RDS decoder link-quality stats for the panel. */
export interface RdsStats {
  /** Complete groups decoded (all four blocks recovered) since the last tune. */
  groups: number;
  /** Fraction of blocks failing their CRC, 0–1 (a link-quality gauge). */
  blockErrorRate: number;
  /** True while the decoder holds block synchronisation. */
  synced: boolean;
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
  /** Required sub-audible tone (CTCSS/DCS) for the squelch to open (NFM only). */
  toneSquelch: ToneSquelch | null;
  /** Spectrum cross-frame averaging strength, 0 (off) .. 1 (very slow). */
  spectrumAvg: number;
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
  /** ADS-B (1090 MHz) map layer enabled. */
  adsb: boolean;
  /** AIS (162 MHz) map layer enabled. */
  ais: boolean;
  /** APRS (144.39 MHz) map layer enabled. */
  aprs: boolean;
  /** Which enabled layer the dongle is sampling right now (round-robin), or null. */
  activeLayer: MapLayer | null;
  /** When true the radio is decoding ISM-band sensors (via rtl_433). */
  ism: boolean;
  /** Selected ISM centre frequency in Hz. */
  ismFreqHz: number;
  /** Whether the rtl_433 binary is installed on the server. The client disables
   *  the ISM tab when false, since there is no built-in fallback decoder. */
  ismAvailable: boolean;
  /** Live speech-to-text of the demodulated audio (via whisper.cpp). */
  transcribe: boolean;
  /** Whether whisper.cpp and a ggml model were found on the server. The client
   *  disables the transcription toggle when false — there is no fallback. */
  transcribeAvailable: boolean;
  /** Name of the whisper model in use (e.g. "small.en"), null when unavailable. */
  transcribeModel: string | null;
  /** All whisper models found on the server, largest first. */
  transcribeModels: string[];
  /** Transcription engine lifecycle, for the panel's status indicator. */
  transcribeStatus: TranscribeStatus;
}

export type ServerMessage =
  /** First message on every connection; carries the server's protocol version. */
  | { type: "hello"; protocol: number }
  | { type: "deviceInfo"; info: DeviceInfo }
  | { type: "state"; state: RadioState }
  /** Channel signal level in dB, for squelch UI / S-meter. `tone` is the
   *  sub-audible tone currently decoded on the channel (NFM only). */
  | {
      type: "signal";
      channelDb: number;
      squelchOpen: boolean;
      tone: ToneSquelch | null;
    }
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
  /**
   * Periodic APRS station table snapshot (only while APRS is on). `framesSeen`
   * is the running count of well-formed AX.25 bursts the demod found.
   */
  | {
      type: "aprs";
      stations: StationReport[];
      messageRate: number;
      framesSeen: number;
    }
  /**
   * Recent ISM decode events (only while ISM is on). The client appends events
   * whose `id` it hasn't seen yet. `bursts` is the total OOK bursts detected,
   * `decoded` the subset that a protocol decoder recognised, `noiseDb` the
   * current noise floor (dBFS), `freqHz` the tuned ISM centre frequency.
   */
  | {
      type: "ism";
      events: IsmEvent[];
      bursts: number;
      decoded: number;
      noiseDb: number;
      freqHz: number;
    }
  /**
   * Decoded RDS for the tuned FM station (only in WFM mode). `station` is null
   * until a Programme Identification code is recovered; `stats` reports link
   * quality. Sent ~1×/s and reset on every retune or mode change.
   */
  | { type: "rds"; station: RdsStation | null; stats: RdsStats }
  /**
   * Transcribed speech segments (only while transcription is on). Sent
   * incrementally as audio chunks complete; the recent history is also sent
   * once on connect. Clients merge by `id`.
   */
  | { type: "transcript"; segments: TranscriptSegment[] }
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
  toneSquelch: null,
  spectrumAvg: 0.2,
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
  aprs: false,
  activeLayer: null,
  ism: false,
  ismFreqHz: ISM_FREQ_HZ,
  ismAvailable: false,
  transcribe: false,
  transcribeAvailable: false,
  transcribeModel: null,
  transcribeModels: [],
  transcribeStatus: "off",
};
