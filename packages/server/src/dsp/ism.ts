// ISM-band OOK/ASK decoder, in the spirit of rtl_433. Cheap 315/433/868/915 MHz
// devices (door/window sensors, remotes, doorbells, weather stations, TPMS, …)
// almost all use on-off keying: the carrier is switched on and off, and data is
// coded in the *durations* of the on (pulse) and off (gap) intervals.
//
// Pipeline:
//   |IQ| envelope -> adaptive threshold (slow noise-floor EMA + hysteresis)
//   -> pulse/gap durations (µs) -> packet framing (split on a long gap)
//   -> protocol decoders (EV1527/PT2262 PWM, plus a generic raw fallback).
//
// We don't FM/IF anything: OOK is pure amplitude, so an off-centre transmitter
// anywhere in the captured span is detected just the same. Decoders that lack a
// CRC (most cheap remotes) are guarded by tight timing structure and de-duplicated
// across the 3–10× repeats a device sends, so random noise rarely surfaces.

import { ISM_SAMPLE_RATE, type IsmEvent } from "@sdr/shared";

const US_PER_SAMPLE = 1e6 / ISM_SAMPLE_RATE; // 4 µs @ 250 kSPS
const RESET_US = 3500; // a gap longer than this ends the current packet
const MIN_PULSES = 8; // ignore bursts shorter than this
const MAX_PULSES = 1500; // guard against a stuck carrier
const ON_RATIO = 8; // |z|² must exceed floor×this to start a pulse (~9 dB)
const OFF_RATIO = 4; // and fall below floor×this to end it (hysteresis)
const FLOOR_ALPHA = 0.002; // noise-floor EMA (updated only between pulses)
const DEDUP_MS = 2000; // identical packets within this window are one device
const MAX_EVENTS = 80; // rolling buffer broadcast to the client

// FSK discriminator path (runs in parallel with the OOK envelope detector). The
// two frequency levels are tracked with a fast-expand / slow-decay min & max
// (rtl_433's min-max slicer), and the decision is their midpoint. A *short* reset
// means any amplitude gap ends the packet — true FSK has a constant envelope, so
// this cleanly rejects OOK bursts (which are all amplitude gaps) from the FSK path.
const FSK_EXPAND = 0.1; // rate the min/max jump out to a new frequency extreme
const FSK_DECAY = 0.0004; // rate they relax back toward the mean (forget old extremes)
const FSK_RESET_US = 100; // signal absent this long ends an FSK packet
const FSK_HYST_FRAC = 0.15; // decision hysteresis, as a fraction of the deviation span

export class IsmReceiver {
  private floor = 1e-3;
  private on = false;
  private run = 0; // samples in the current on/off run
  private peak = 0; // peak |z|² seen in the current packet
  private pulses: number[] = [];
  private gaps: number[] = [];

  // FSK detector state: a polar-discriminator path that turns the *frequency*
  // mark/space swing into the same pulse/gap run-lengths the OOK path produces,
  // so the registry decodes FSK devices (TPMS, Fine Offset …) with no new slicer.
  private dI = 0;
  private dQ = 0; // discriminator history (previous sample)
  private fMax = 0; // tracked high frequency level (mark)
  private fMin = 0; // tracked low frequency level (space)
  private fActive = false; // inside an FSK packet (signal present)
  private fOn = false; // currently in a "mark" (high-frequency) run
  private fRun = 0;
  private fIdle = 0; // samples since the signal was last present
  private fPeak = 0;
  private fPulses: number[] = [];
  private fGaps: number[] = [];

  private events: IsmEvent[] = [];
  private nextId = 1;
  private bursts = 0;
  private decoded = 0;
  // key (model:code) -> {event, visible}, to collapse a device's repeated
  // transmissions. `visible` gates noisy/untrusted bursts: a raw or CRC-only
  // decode is held out of the event log until it repeats (real devices transmit
  // 3–10×; random noise almost never reproduces the same code).
  private recent = new Map<string, { ev: IsmEvent; visible: boolean }>();

  get totalBursts(): number {
    return this.bursts;
  }
  get totalDecoded(): number {
    return this.decoded;
  }
  /** Current noise floor as relative dBFS (|z|² of normalised IQ). */
  get noiseDb(): number {
    return Math.round(10 * Math.log10(Math.max(this.floor, 1e-9)) * 10) / 10;
  }
  get recentEvents(): IsmEvent[] {
    return this.events;
  }

  reset() {
    this.floor = 1e-3;
    this.on = false;
    this.run = 0;
    this.peak = 0;
    this.pulses = [];
    this.gaps = [];
    this.dI = this.dQ = 0;
    this.fMax = this.fMin = 0;
    this.fActive = this.fOn = false;
    this.fRun = this.fIdle = this.fPeak = 0;
    this.fPulses = [];
    this.fGaps = [];
    this.events = [];
    this.recent.clear();
    this.nextId = 1;
    this.bursts = 0;
    this.decoded = 0;
  }

  /** `iq` is interleaved complex at ISM_SAMPLE_RATE. */
  process(iq: Float32Array) {
    const n = iq.length >> 1;
    for (let k = 0; k < n; k++) {
      const i = iq[2 * k]!;
      const q = iq[2 * k + 1]!;
      const mag2 = i * i + q * q;
      this.run++;

      if (this.on) {
        if (mag2 > this.peak) this.peak = mag2;
        if (mag2 < this.floor * OFF_RATIO) {
          this.pulses.push(this.run * US_PER_SAMPLE);
          if (this.pulses.length > MAX_PULSES) this.flush();
          this.on = false;
          this.run = 0;
        }
      } else {
        // Track the noise floor only while idle, so pulses don't drag it up.
        this.floor += FLOOR_ALPHA * (mag2 - this.floor);
        if (this.floor < 1e-7) this.floor = 1e-7;
        if (mag2 > this.floor * ON_RATIO) {
          const gapUs = this.run * US_PER_SAMPLE;
          if (this.pulses.length > 0) {
            if (gapUs > RESET_US) this.flush();
            else this.gaps.push(gapUs);
          }
          this.on = true;
          this.run = 0;
        } else if (this.pulses.length > 0 && this.run * US_PER_SAMPLE > RESET_US) {
          this.flush(); // trailing silence after the final pulse
        }
      }

      // --- FSK path: discriminate frequency, slice mark/space into runs -------
      // im(z·conj(prev)) ∝ sin(Δφ); normalised by |z|² it's the instantaneous
      // frequency, amplitude-independent. No atan2 — we only need above/below the
      // carrier centre. Amplitude-gated to the OOK floor so silence stays silent.
      const fim = q * this.dI - i * this.dQ;
      this.dI = i;
      this.dQ = q;
      if (mag2 > this.floor * ON_RATIO) {
        const f = fim / (mag2 + 1e-12);
        if (!this.fActive) {
          this.fActive = true;
          this.fOn = false;
          this.fRun = 0;
          this.fIdle = 0;
          this.fMax = f; // seed both levels on the first in-packet sample
          this.fMin = f;
          this.fPeak = mag2;
          this.fPulses = [];
          this.fGaps = [];
        }
        if (mag2 > this.fPeak) this.fPeak = mag2;
        // Min/max chase: jump out fast to a new extreme, relax back slowly.
        this.fMax += (f > this.fMax ? FSK_EXPAND : FSK_DECAY) * (f - this.fMax);
        this.fMin += (f < this.fMin ? FSK_EXPAND : FSK_DECAY) * (f - this.fMin);
        const mid = (this.fMax + this.fMin) * 0.5;
        const hyst = (this.fMax - this.fMin) * FSK_HYST_FRAC;
        const mark = this.fOn ? f > mid - hyst : f > mid + hyst;
        if (mark && !this.fOn) {
          if (this.fPulses.length > 0) this.fGaps.push(this.fRun * US_PER_SAMPLE);
          this.fOn = true;
          this.fRun = 0;
        } else if (!mark && this.fOn) {
          this.fPulses.push(this.fRun * US_PER_SAMPLE);
          if (this.fPulses.length > MAX_PULSES) this.flushFsk();
          this.fOn = false;
          this.fRun = 0;
        }
        this.fRun++;
        this.fIdle = 0;
      } else if (this.fActive) {
        if (this.fIdle === 0) {
          // First absent sample: the carrier dropped, so close the final
          // present run — a mark becomes a pulse, a space the trailing gap.
          // (NRZ needs that last space; without it trailing 0-bits are lost.)
          if (this.fOn) this.fPulses.push(this.fRun * US_PER_SAMPLE);
          else if (this.fPulses.length > 0) this.fGaps.push(this.fRun * US_PER_SAMPLE);
          this.fRun = 0;
        }
        this.fIdle++;
        if (this.fIdle * US_PER_SAMPLE > FSK_RESET_US) {
          this.flushFsk();
          this.fActive = false;
        }
      }
    }
  }

  /** Snapshot the rolling event buffer (client appends ids it hasn't seen). */
  snapshot(): IsmEvent[] {
    return this.events;
  }

  private flush() {
    const pulses = this.pulses;
    const gaps = this.gaps;
    this.pulses = [];
    this.gaps = [];
    const snr =
      10 * Math.log10(Math.max(this.peak, 1e-9) / Math.max(this.floor, 1e-9));
    this.peak = 0;
    if (pulses.length < MIN_PULSES) return;
    this.bursts++;
    this.decode(pulses, gaps, Math.round(snr * 10) / 10);
  }

  private flushFsk() {
    const pulses = this.fPulses;
    const gaps = this.fGaps;
    this.fPulses = [];
    this.fGaps = [];
    this.fOn = false;
    this.fRun = 0;
    const snr =
      10 * Math.log10(Math.max(this.fPeak, 1e-9) / Math.max(this.floor, 1e-9));
    this.fPeak = 0;
    if (pulses.length < MIN_PULSES) return;
    this.bursts++;
    this.decode(pulses, gaps, Math.round(snr * 10) / 10, "FSK");
  }

  // `modulation` is "OOK" for envelope-detected bursts and "FSK" for the
  // discriminator path; it selects which registry decoders see the burst and
  // labels the raw fallback. Defaults to OOK so the amplitude path is unchanged.
  private decode(pulses: number[], gaps: number[], snr: number, modulation: Modulation = "OOK") {
    // Each line coding is sliced at most once per burst (lazily, on first demand)
    // and shared across every decoder that consumes it. A decoder matches only
    // when its checksum/parity/structure guard passes, turning hex noise into
    // real values; the first match wins, exactly as the old chain did.
    const burst = makeBurst(pulses, gaps, modulation);
    for (const d of REGISTRY) {
      if (d.modulation && d.modulation !== modulation) continue;
      const r = d.fn(burst);
      if (r) return this.emitDecoded(d.model, d.protocol, r, snr, d.trusted);
    }
    const g = decodeGeneric(pulses, gaps);
    if (g)
      this.emit(
        {
          model: modulation === "FSK" ? "FSK" : "OOK",
          protocol: modulation === "FSK" ? "FSK" : "PWM",
          bits: g.bits,
          code: g.code,
          snrDb: snr,
        },
        false,
      );
  }

  private emitDecoded(
    model: string,
    protocol: string,
    d: Decoded,
    snrDb: number,
    trusted: boolean,
  ) {
    this.decoded++;
    this.emit(
      {
        model,
        protocol,
        bits: d.bits,
        code: d.code,
        snrDb,
        deviceId: d.deviceId,
        data: d.data,
        channel: d.channel,
        tempC: d.tempC,
        humidityPct: d.humidityPct,
        batteryLow: d.batteryLow,
        windSpeedKmh: d.windSpeedKmh,
        windDirDeg: d.windDirDeg,
        rainMm: d.rainMm,
        pressureHpa: d.pressureHpa,
        pressureKpa: d.pressureKpa,
      },
      trusted,
    );
  }

  private emit(fields: Omit<IsmEvent, "id" | "time" | "repeats">, trusted: boolean) {
    const now = Date.now();
    const key = `${fields.model}:${fields.code}`;
    const w = this.recent.get(key);
    if (w && now - w.ev.time < DEDUP_MS) {
      w.ev.repeats++;
      w.ev.time = now;
      w.ev.snrDb = fields.snrDb;
      this.show(w); // a confirming repeat promotes a previously-held burst
      return;
    }
    const entry = { ev: { id: 0, time: now, repeats: 1, ...fields }, visible: false };
    this.recent.set(key, entry);
    if (trusted) this.show(entry); // strong structural guard → show immediately
    // Drop stale dedup keys so the map can't grow without bound.
    if (this.recent.size > 256) {
      for (const [k, e] of this.recent)
        if (now - e.ev.time > DEDUP_MS) this.recent.delete(k);
    }
  }

  /** Reveal a held event, assigning it a fresh id so it surfaces newest-first. */
  private show(entry: { ev: IsmEvent; visible: boolean }) {
    if (entry.visible) return;
    entry.visible = true;
    entry.ev.id = this.nextId++;
    this.events.push(entry.ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
}

// ---------------------------------------------------------------------------
// Protocol decoders
// ---------------------------------------------------------------------------

interface Decoded {
  bits: number;
  code: string;
  deviceId?: string;
  data?: string;
  channel?: string;
  tempC?: number;
  humidityPct?: number;
  batteryLow?: boolean;
  windSpeedKmh?: number;
  windDirDeg?: number;
  rainMm?: number;
  pressureHpa?: number;
  pressureKpa?: number;
}

// --- decoder registry -------------------------------------------------------

/** Line coding a decoder consumes. "raw" reads pulse/gap durations directly. */
type Coding = "raw" | "pwm" | "manchester" | "ppm" | "nrz";
/** How the burst was demodulated: amplitude (OOK) or frequency (FSK). */
type Modulation = "OOK" | "FSK";

/**
 * The per-burst inputs every decoder receives. `pulses`/`gaps` are the raw µs
 * run-lengths; the coded streams are computed once on first access and cached.
 * `manchester` is the *half-bit* level array — decoders pair it with
 * `manchesterDecode`, trying both bit phases to find their sync word.
 */
interface Burst {
  modulation: Modulation;
  pulses: number[];
  gaps: number[];
  readonly pwm: number[];
  readonly manchester: number[];
  readonly ppm: number[];
  readonly nrz: number[];
}

interface DecoderDef {
  /** Event model label, e.g. "Acurite-5n1". */
  model: string;
  /** Line-coding label surfaced in IsmEvent.protocol. */
  protocol: string;
  /** Primary stream consumed (documentation; fn may read others off Burst). */
  coding: Coding;
  /** Restrict to one modulation; undefined = both. */
  modulation?: Modulation;
  /**
   * Immediate decoders have a strong structural guard (CRC/checksum + fixed
   * fields) and surface at once. Untrusted ones (digest-only, fixed-code) are
   * held until a confirming repeat — same semantics as the original chain.
   */
  trusted: boolean;
  fn: (b: Burst) => Decoded | null;
}

/** Build a burst whose coded streams slice lazily and cache for this burst. */
function makeBurst(pulses: number[], gaps: number[], modulation: Modulation): Burst {
  let pwm: number[] | null = null;
  let man: number[] | null = null;
  let ppm: number[] | null = null;
  let nrz: number[] | null = null;
  return {
    modulation,
    pulses,
    gaps,
    get pwm() {
      return (pwm ??= sliceBitsPwm(pulses, gaps));
    },
    get manchester() {
      return (man ??= sliceBitsManchester(pulses, gaps));
    },
    get ppm() {
      return (ppm ??= sliceBitsPpm(pulses, gaps));
    },
    get nrz() {
      return (nrz ??= sliceBitsNrz(pulses, gaps));
    },
  };
}

/**
 * Registered decoders, tried in order — strongest guards first, so a multi-byte
 * CRC frame is never shadowed by a weaker fixed-code match; the raw OOK/FSK
 * fallback in `decode()` runs only if nothing here matches. Decoder fns are pure
 * `(Burst) => Decoded | null`, reading whichever sliced stream they need.
 *
 * Scope note: this path is amplitude/OOK and frequency/FSK *pulse* decoding. It
 * does NOT cover the encrypted/rolling-code remotes (car fobs) or the LPWAN/
 * wM-Bus side of metering — those need crypto or a full PHY, out of scope here.
 */
const REGISTRY: DecoderDef[] = [
  { model: "Acurite-Tower", protocol: "PWM", coding: "pwm", trusted: true, fn: decodeAcuriteTower },
  { model: "Acurite-5n1", protocol: "PWM", coding: "pwm", trusted: true, fn: decodeAcurite5n1 },
  { model: "Honeywell-Door", protocol: "Manchester", coding: "manchester", trusted: true, fn: decodeHoneywell },
  { model: "Oregon", protocol: "Manchester", coding: "manchester", trusted: true, fn: decodeOregon },
  { model: "Ambient-F007TH", protocol: "Manchester", coding: "manchester", trusted: true, fn: decodeF007th },
  // Digest-only, no constant guard → trust it only once it repeats.
  { model: "LaCrosse-TX", protocol: "PWM", coding: "pwm", trusted: false, fn: decodeLaCrosse },
  // Fixed 0xF nibble only, no CRC → held until a confirming repeat.
  { model: "Nexus-TH", protocol: "PPM", coding: "ppm", trusted: false, fn: decodeNexus },
  { model: "EV1527", protocol: "PWM", coding: "raw", trusted: true, fn: decodeEv1527 },
  // FSK devices — only ever fed frequency-discriminated bursts.
  { model: "Toyota-TPMS", protocol: "FSK", coding: "nrz", modulation: "FSK", trusted: true, fn: decodeToyotaTpms },
  { model: "Fineoffset-WH25", protocol: "FSK", coding: "nrz", modulation: "FSK", trusted: true, fn: decodeFineOffset },
];

// --- bit/byte helpers shared by the framed (CRC) decoders -------------------

/**
 * Slice a PWM burst to a bitstream: each pulse/gap pair is a '1' when the pulse
 * is the longer of the two, else '0'. EV1527, Acurite and LaCrosse all use this
 * "long mark = 1" convention, so one slice feeds every framed decoder. Sync
 * pulses (roughly equal mark/space) become stray bits the decoders skip past.
 */
function sliceBitsPwm(pulses: number[], gaps: number[]): number[] {
  const n = Math.min(pulses.length, gaps.length);
  const bits: number[] = new Array(n);
  for (let i = 0; i < n; i++) bits[i] = pulses[i]! > gaps[i]! ? 1 : 0;
  return bits;
}

/**
 * Slice a burst to Manchester *half-bits*. Each pulse (mark) / gap (space) run is
 * `round(dur / T)` half-bit slots of that level, where `T` (one half-bit) is the
 * shortest run in the burst. Clean Manchester only has 1- or 2-unit runs, so a run
 * far above that means we lost sync → bail. The returned level array is paired into
 * data bits by `manchesterDecode` (the caller tries both bit phases, since a pure
 * 0101… preamble is phase-ambiguous until the sync word breaks the symmetry).
 */
function sliceBitsManchester(pulses: number[], gaps: number[]): number[] {
  const n = Math.min(pulses.length, gaps.length);
  if (n < 8) return [];
  let T = Infinity;
  for (let i = 0; i < n; i++) {
    if (pulses[i]! < T) T = pulses[i]!;
    if (gaps[i]! < T) T = gaps[i]!;
  }
  if (T < 60 || T > 2000) return []; // implausible half-bit period
  const half: number[] = [];
  for (let i = 0; i < n; i++) {
    const np = Math.round(pulses[i]! / T);
    const ng = Math.round(gaps[i]! / T);
    if (np < 1 || np > 4 || ng < 1 || ng > 4) return []; // not Manchester
    for (let k = 0; k < np; k++) half.push(1);
    for (let k = 0; k < ng; k++) half.push(0);
  }
  return half;
}

/**
 * Pair Manchester half-bits to data bits for a given bit phase (`start` 0 or 1).
 * A mid-bit low→high transition (01) is a 1, high→low (10) a 0 — G.E. Thomas /
 * IEEE convention; `invert` flips it (Oregon). An equal-level pair (00/11) is an
 * illegal transition → null, so legality is itself an integrity guard.
 */
function manchesterDecode(half: number[], start: number, invert: boolean): number[] | null {
  const bits: number[] = [];
  for (let i = start; i + 1 < half.length; i += 2) {
    const a = half[i]!;
    const b = half[i + 1]!;
    if (a === b) return null; // illegal same-level pair
    bits.push((b > a ? 1 : 0) ^ (invert ? 1 : 0));
  }
  return bits.length >= 8 ? bits : null;
}

/**
 * Every legal data-bit reading of a Manchester half-bit array: both bit phases
 * (a 0101… preamble is phase-ambiguous) and both polarities. A device decoder
 * scans each candidate for its sync word / checksum and keeps the one that
 * passes — so the convention doesn't have to be known a priori.
 */
function manchesterCandidates(half: number[]): number[][] {
  const out: number[][] = [];
  for (const invert of [false, true])
    for (const start of [0, 1]) {
      const d = manchesterDecode(half, start, invert);
      if (d) out.push(d);
    }
  return out;
}

/**
 * Differential Manchester (biphase-mark): each bit is two chips with a guaranteed
 * transition at the bit boundary; a transition *within* the bit is a 1, none a 0.
 * Polarity-independent (it reads transitions, not levels). Returns null if the
 * boundary-transition invariant is ever violated — that's the integrity guard.
 */
function diffManchester(chips: number[], start: number): number[] | null {
  const bits: number[] = [];
  for (let i = start; i + 1 < chips.length; i += 2) {
    if (i > start && chips[i] === chips[i - 1]) return null; // missing boundary transition
    bits.push(chips[i] !== chips[i + 1] ? 1 : 0);
  }
  return bits.length >= 8 ? bits : null;
}

/** First index of `needle` within `hay` (bit arrays), or -1. */
function findBits(hay: number[], needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * PPM slice (pulse-position): the pulse is ~constant and the *gap* carries the bit
 * — short gap = 0, long gap = 1 (Nexus and friends). Threshold at the midpoint of
 * the gap range; bail if the gaps aren't bimodal (so it can't fire on noise).
 */
function sliceBitsPpm(pulses: number[], gaps: number[]): number[] {
  const n = Math.min(pulses.length, gaps.length);
  if (n < 16) return [];
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const g = gaps[i]!;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  if (hi / Math.max(lo, 1) < 1.6) return []; // not two-level → not PPM
  const thr = (lo + hi) / 2;
  const bits: number[] = new Array(n);
  for (let i = 0; i < n; i++) bits[i] = gaps[i]! > thr ? 1 : 0;
  return bits;
}

/**
 * NRZ/PCM slice: one symbol per bit, the level *is* the bit (mark = 1, space = 0).
 * Each pulse/gap run expands to round(dur / T) identical bits, T = shortest run.
 * Used by FSK frames that are neither pulse-width nor Manchester coded.
 */
function sliceBitsNrz(pulses: number[], gaps: number[]): number[] {
  const n = Math.min(pulses.length, gaps.length);
  if (n < 4) return [];
  let T = Infinity;
  for (let i = 0; i < n; i++) {
    if (pulses[i]! < T) T = pulses[i]!;
    if (gaps[i]! < T) T = gaps[i]!;
  }
  if (T < 20 || T > 4000) return [];
  const bits: number[] = [];
  for (let i = 0; i < n; i++) {
    const np = Math.max(1, Math.round(pulses[i]! / T));
    const ng = Math.max(1, Math.round(gaps[i]! / T));
    if (np > 64 || ng > 64) return []; // stuck level → not a clean NRZ frame
    for (let k = 0; k < np; k++) bits.push(1);
    for (let k = 0; k < ng; k++) bits.push(0);
  }
  return bits;
}

/** Pack `count` bytes MSB-first from `bits` starting at `off`. */
function packBytes(bits: number[], off: number, count: number): number[] {
  const out: number[] = new Array(count);
  for (let b = 0; b < count; b++) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | bits[off + b * 8 + i]!;
    out[b] = v;
  }
  return out;
}

/** 1 if the byte has an odd number of set bits (used for even-parity checks). */
function parity8(v: number): number {
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return v & 1;
}

/**
 * rtl_433's reflected byte-wise LFSR digest (lfsr_digest8_reflect): bytes are
 * consumed last-to-first, bits LSB-first, XORing the rolling key into the sum on
 * each set bit. Used as the checksum for several LaCrosse sensors.
 */
function lfsrDigest8Reflect(
  msg: number[],
  bytes: number,
  gen: number,
  key: number,
): number {
  let sum = 0;
  for (let k = bytes - 1; k >= 0; k--) {
    const data = msg[k]!;
    for (let i = 0; i < 8; i++) {
      if ((data >> i) & 1) sum ^= key;
      key = key & 1 ? (key >> 1) ^ gen : key >> 1;
    }
  }
  return sum & 0xff;
}

/** Byte-wise CRC-8, MSB-first (Oregon v3, Honeywell: poly 0x31, init 0x00). */
function crc8(b: number[], off: number, len: number, poly: number, init: number): number {
  let crc = init;
  for (let i = 0; i < len; i++) {
    crc ^= b[off + i]!;
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** Byte-wise CRC-16, MSB-first (Honeywell poly 0x8005 / 2GIG 0x8050). */
function crc16(b: number[], off: number, len: number, poly: number, init: number): number {
  let crc = init;
  for (let i = 0; i < len; i++) {
    crc ^= b[off + i]! << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/**
 * rtl_433's forward byte-wise LFSR digest (lfsr_digest8): bytes MSB-first, the
 * rolling key XORed into the sum on each set bit, key shifted left through `gen`.
 * Used as the checksum for Ambient/TFA F007TH and others.
 */
function lfsrDigest8(b: number[], off: number, len: number, gen: number, key: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const data = b[off + i]!;
    for (let bit = 7; bit >= 0; bit--) {
      if ((data >> bit) & 1) sum ^= key;
      key = key & 0x80 ? ((key << 1) ^ gen) & 0xff : (key << 1) & 0xff;
    }
  }
  return sum & 0xff;
}

/** Sum of bytes in a range, masked to 8 bits (Acurite/F007TH checksums). */
function byteSum(b: number[], off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) s += b[off + i]!;
  return s & 0xff;
}

/** Bit-reverse a nibble (Oregon transmits each nibble LSB-first). */
function reverse4(v: number): number {
  return (((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3)) & 0xf;
}

/** Read a big-endian unsigned field of `len` bits from `bits` at `off`. */
function bitsToInt(bits: number[], off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = (v << 1) | (bits[off + i] ?? 0);
  return v >>> 0;
}

const hex = (b: number[]): string =>
  b.map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Acurite 592TXR / Tower (433.92 MHz) temp+humidity. 7-byte PWM frame:
 *   b0: CC IIIIII   channel(2) + id high(6)
 *   b1: IIIIIIII    id low(8)
 *   b2: p B 00 0100 parity + battery + constant message-type 0x04
 *   b3: p HHHHHHH   parity + humidity %
 *   b4: p ?? TTTTT  parity + temp high
 *   b5: p TTTTTTT   parity + temp low
 *   b6: checksum = (b0+…+b5) & 0xff
 * Guarded by the checksum, per-byte even parity on b2–b5, and the fixed 0x04
 * message-type nibble — together ~1-in-130k against random bits.
 */
function decodeAcuriteTower(b0: Burst): Decoded | null {
  const bits = b0.pwm;
  for (let off = 0; off + 56 <= bits.length; off++) {
    const b = packBytes(bits, off, 7);
    if (((b[0]! + b[1]! + b[2]! + b[3]! + b[4]! + b[5]!) & 0xff) !== b[6]!) continue;
    if (parity8(b[2]!) || parity8(b[3]!) || parity8(b[4]!) || parity8(b[5]!)) continue;
    if ((b[2]! & 0x3f) !== 0x04) continue; // constant message type
    const humidity = b[3]! & 0x7f;
    const tempRaw = ((b[4]! & 0x7f) << 7) | (b[5]! & 0x7f);
    const tempC = (tempRaw - 1000) / 10;
    if (tempC < -40 || tempC > 70 || humidity < 1 || humidity > 99) continue;
    const id = ((b[0]! & 0x3f) << 8) | b[1]!;
    const channel = ["C", "x", "B", "A"][(b[0]! >> 6) & 0x3]!;
    return {
      bits: 56,
      code: hex(b),
      deviceId: id.toString(16).padStart(4, "0"),
      channel,
      tempC,
      humidityPct: humidity,
      batteryLow: (b[2]! & 0x40) === 0,
      data: `${tempC.toFixed(1)}°C ${humidity}% ch${channel}`,
    };
  }
  return null;
}

/**
 * LaCrosse TX141TH-Bv2 (433.92 MHz) temp+humidity. 5-byte PWM frame:
 *   b0: id(8)
 *   b1: BAT(1) TEST(1) CH(2) TEMPhi(4)
 *   b2: TEMPlo(8)   temp_c = (raw - 500)/10
 *   b3: humidity %
 *   b4: lfsr_digest8_reflect(b0..b3, gen 0x31, key 0xf4)
 * Digest-only, so a single hit is held until it repeats (see emitDecoded).
 */
function decodeLaCrosse(b0: Burst): Decoded | null {
  const bits = b0.pwm;
  for (let off = 0; off + 40 <= bits.length; off++) {
    const b = packBytes(bits, off, 5);
    if (lfsrDigest8Reflect(b, 4, 0x31, 0xf4) !== b[4]!) continue;
    const tempRaw = ((b[1]! & 0x0f) << 8) | b[2]!;
    const tempC = (tempRaw - 500) / 10;
    const humidity = b[3]!;
    if (tempC < -40 || tempC > 60 || humidity > 100) continue;
    const channel = ((b[1]! >> 4) & 0x3).toString();
    return {
      bits: 40,
      code: hex(b),
      deviceId: b[0]!.toString(16).padStart(2, "0"),
      channel,
      tempC,
      humidityPct: humidity,
      batteryLow: ((b[1]! >> 7) & 1) === 1,
      data: `${tempC.toFixed(1)}°C ${humidity}% ch${channel}`,
    };
  }
  return null;
}

/**
 * EV1527 / PT2262-style fixed-code PWM: 24 bits, each one pulse+gap pair of
 * constant period (~4 base units). A '1' is a long pulse + short gap, a '0' the
 * reverse. Validated by period regularity and a clean ~3:1 high/low ratio (no
 * CRC exists, so structure is the only guard).
 */
function decodeEv1527(b: Burst): Decoded | null {
  const { pulses, gaps } = b;
  const n = Math.min(pulses.length, gaps.length);
  if (n < 24) return null;
  const P = pulses.slice(0, 24);
  const G = gaps.slice(0, 24);

  let sum = 0;
  for (let i = 0; i < 24; i++) sum += P[i]! + G[i]!;
  const period = sum / 24;
  if (period < 200 || period > 4000) return null; // ~50 µs–1 ms base unit

  let code = 0;
  for (let i = 0; i < 24; i++) {
    const hi = P[i]!;
    const lo = G[i]!;
    if (Math.abs(hi + lo - period) > period * 0.4) return null; // irregular
    const ratio = Math.max(hi, lo) / Math.max(Math.min(hi, lo), 1);
    if (ratio < 1.8 || ratio > 8) return null; // not a clean short/long
    code = (code * 2 + (hi > lo ? 1 : 0)) >>> 0;
  }
  const id = Math.floor(code / 16); // top 20 bits
  const data = code & 0x0f; // bottom 4 bits
  return {
    bits: 24,
    code: code.toString(16).padStart(6, "0"),
    deviceId: id.toString(16).padStart(5, "0"),
    data: `data 0x${data.toString(16)}`,
  };
}

// Acurite 5n1 wind-direction lookup (raw nibble → degrees), per rtl_433.
const ACU5_WINDDIR = [
  315.0, 247.5, 292.5, 270.0, 337.5, 225.0, 0.0, 202.5,
  67.5, 135.0, 90.0, 112.5, 45.0, 157.5, 22.5, 180.0,
];

/**
 * Acurite 5-in-1 / Iris (433.92 MHz) weather station. 8-byte PWM frame, two
 * interleaved message types selected by byte2 & 0x3f:
 *   0x38 → wind speed + temperature + humidity
 *   0x31 → wind speed + wind direction + rainfall
 * Guarded by the 8-bit byte-sum checksum (byte7), even parity on bytes 2–6, and
 * the constrained message type — together well past 1-in-100k against noise.
 */
function decodeAcurite5n1(b0: Burst): Decoded | null {
  const bits = b0.pwm;
  for (let off = 0; off + 64 <= bits.length; off++) {
    const b = packBytes(bits, off, 8);
    if (byteSum(b, 0, 7) !== b[7]!) continue;
    if (parity8(b[2]!) || parity8(b[3]!) || parity8(b[4]!) || parity8(b[5]!) || parity8(b[6]!))
      continue;
    const type = b[2]! & 0x3f;
    if (type !== 0x31 && type !== 0x38) continue;
    const channel = ["C", "x", "B", "A"][(b[0]! >> 6) & 0x3]!;
    const id = ((b[0]! & 0x0f) << 8) | b[1]!;
    const rawWind = ((b[3]! & 0x1f) << 3) | ((b[4]! & 0x70) >> 4);
    const windKmh = rawWind === 0 ? 0 : Math.round((rawWind * 0.8278 + 1.0) * 10) / 10;
    const base: Decoded = {
      bits: 64,
      code: hex(b),
      deviceId: id.toString(16).padStart(4, "0"),
      channel,
      windSpeedKmh: windKmh,
    };
    if (type === 0x31) {
      const dir = ACU5_WINDDIR[b[4]! & 0x0f]!;
      const rainRaw = ((b[5]! & 0x7f) << 7) | (b[6]! & 0x7f);
      const rainMm = Math.round(rainRaw * 0.254 * 10) / 10;
      return {
        ...base,
        windDirDeg: dir,
        rainMm,
        data: `${windKmh} km/h ${dir}° rain ${rainMm} mm ch${channel}`,
      };
    }
    const tempRaw = ((b[4]! & 0x0f) << 7) | (b[5]! & 0x7f);
    const tempC = Math.round((((tempRaw - 400) / 10 - 32) * 5) / 9 * 10) / 10;
    const humidity = b[6]! & 0x7f;
    if (tempC < -40 || tempC > 70 || humidity > 100) continue;
    return {
      ...base,
      tempC,
      humidityPct: humidity,
      data: `${tempC}°C ${humidity}% ${windKmh} km/h ch${channel}`,
    };
  }
  return null;
}

// Known Oregon Scientific 16-bit sensor IDs (temp/humidity families). The ID
// match is a 1-in-65k guard on its own, on top of the nibble-sum checksum.
const OREGON_IDS = new Set([
  0x1d20, 0x1d30, 0xf824, 0xf024, 0xf224, 0xfa24, 0xc844, 0xec40, 0xec70,
]);

/**
 * Oregon Scientific v2.1/v3 temp+humidity (THGR122N/228N/810/968 …). Manchester,
 * data nibbles sent LSB-first (reflected). After a 1-preamble and a sync nibble
 * we read 16 reflected nibbles: id(0-3), channel(4), rolling/flags(5-7), BCD
 * temperature(8-11, ×0.1 °C with a sign bit) and BCD humidity(12-13), then a
 * nibble-sum checksum(14-15). Guarded by the sensor-ID whitelist + that checksum.
 */
function decodeOregon(b0: Burst): Decoded | null {
  for (const bb of manchesterCandidates(b0.manchester)) {
    let ones = 0;
    let preEnd = -1;
    for (let k = 0; k < bb.length; k++) {
      if (bb[k] === 1) ones++;
      else {
        if (ones >= 16) {
          preEnd = k;
          break;
        }
        ones = 0;
      }
    }
    if (preEnd < 0) continue;
    // The sync nibble (0x5 v3 / 0xA v2) sits within a few bits of the preamble end.
    let dataStart = -1;
    for (let s = preEnd; s < preEnd + 8 && s + 4 <= bb.length; s++) {
      const nib = (bb[s]! << 3) | (bb[s + 1]! << 2) | (bb[s + 2]! << 1) | bb[s + 3]!;
      if (nib === 0x5 || nib === 0xa) {
        dataStart = s + 4;
        break;
      }
    }
    if (dataStart < 0 || dataStart + 16 * 4 > bb.length) continue;
    const nib: number[] = [];
    for (let k = 0; k < 16; k++) {
      const o = dataStart + k * 4;
      nib.push(reverse4((bb[o]! << 3) | (bb[o + 1]! << 2) | (bb[o + 2]! << 1) | bb[o + 3]!));
    }
    const id = (((nib[0]! << 4) | nib[1]!) << 8) | ((nib[2]! << 4) | nib[3]!);
    if (!OREGON_IDS.has(id)) continue;
    let sum = 0;
    for (let k = 0; k < 14; k++) sum += nib[k]!;
    if ((sum & 0xff) !== ((nib[15]! << 4) | nib[14]!)) continue;
    let tempC = nib[10]! * 10 + nib[9]! + nib[8]! * 0.1;
    if (nib[11]! & 0x8) tempC = -tempC;
    tempC = Math.round(tempC * 10) / 10;
    const humidity = nib[13]! * 10 + nib[12]!;
    if (tempC < -40 || tempC > 70 || humidity > 100) continue;
    const channel = (nib[4]! || 0).toString();
    return {
      bits: 80,
      code: id.toString(16).padStart(4, "0") + nib.slice(4).map((x) => x.toString(16)).join(""),
      deviceId: id.toString(16).padStart(4, "0"),
      channel,
      tempC,
      humidityPct: humidity,
      batteryLow: (nib[7]! & 0x4) !== 0,
      data: `${tempC}°C ${humidity}% ch${channel}`,
    };
  }
  return null;
}

/**
 * Nexus-TH (and Sencor/Digoo clones), 433.92 MHz, PPM, 36 bits:
 *   id(0-7) batt(8) –(9) ch(10-11) temp(12-23, signed ×0.1 °C) const0xF(24-27)
 *   humidity(28-35). No CRC, only the fixed 0xF nibble + ranges → held until it
 *   repeats (real sensors send the frame ~12×; noise won't reproduce it).
 */
function decodeNexus(b0: Burst): Decoded | null {
  const bits = b0.ppm;
  for (let off = 0; off + 36 <= bits.length; off++) {
    if (bitsToInt(bits, off + 24, 4) !== 0xf) continue; // constant nibble
    let tempRaw = bitsToInt(bits, off + 12, 12);
    if (tempRaw & 0x800) tempRaw -= 0x1000;
    const tempC = Math.round(tempRaw) / 10;
    const humidity = bitsToInt(bits, off + 28, 8);
    if (tempC < -40 || tempC > 70 || humidity < 1 || humidity > 100) continue;
    const id = bitsToInt(bits, off, 8);
    const channel = (bitsToInt(bits, off + 10, 2) + 1).toString();
    return {
      bits: 36,
      code: id.toString(16).padStart(2, "0") + bitsToInt(bits, off + 8, 28).toString(16),
      deviceId: id.toString(16).padStart(2, "0"),
      channel,
      tempC,
      humidityPct: humidity,
      batteryLow: bits[off + 8] === 0,
      data: `${tempC}°C ${humidity}% ch${channel}`,
    };
  }
  return null;
}

/**
 * Ambient Weather F007TH / TFA 30.3208 (433.92 MHz). Manchester, 6 bytes:
 *   b0: ----MMMM model nibble 0x5   b1: id   b2: B CCC TTTT (batt/channel/temp hi)
 *   b3: temp lo (raw, °F = (raw-400)/10)   b4: humidity   b5: lfsr_digest8 checksum
 * Guarded by that digest (gen 0x98, key 0x3e, ^0x64), the model nibble and ranges.
 */
function decodeF007th(b0: Burst): Decoded | null {
  for (const bb of manchesterCandidates(b0.manchester)) {
    for (let off = 0; off + 48 <= bb.length; off++) {
      const b = packBytes(bb, off, 6);
      if ((lfsrDigest8(b, 0, 5, 0x98, 0x3e) ^ 0x64) !== b[5]!) continue;
      if ((b[0]! & 0x0f) !== 0x05) continue; // model nibble
      const tempRaw = ((b[2]! & 0x0f) << 8) | b[3]!;
      const tempC = Math.round((((tempRaw - 400) / 10 - 32) * 5) / 9 * 10) / 10;
      const humidity = b[4]!;
      if (tempC < -40 || tempC > 70 || humidity > 100) continue;
      const channel = (((b[2]! >> 4) & 0x07) + 1).toString();
      return {
        bits: 48,
        code: hex(b),
        deviceId: b[1]!.toString(16).padStart(2, "0"),
        channel,
        tempC,
        humidityPct: humidity,
        batteryLow: (b[2]! & 0x80) !== 0,
        data: `${tempC}°C ${humidity}% ch${channel}`,
      };
    }
  }
  return null;
}

/**
 * Honeywell/2GIG/Ademco door-window security contact (≈345/433 MHz). Manchester,
 * 6 bytes: b0 = channel(hi nibble) + serial hi, b1-b2 serial, b3 event flags
 * (bit7 contact, bit6 tamper, bit3 batt-low, bit2 heartbeat), b4-b5 = CRC-16 over
 * b0–b3 (Honeywell poly 0x8005 / 2GIG 0x8050). The 16-bit CRC is the guard.
 */
function decodeHoneywell(b0: Burst): Decoded | null {
  for (const bb of manchesterCandidates(b0.manchester)) {
    for (let off = 0; off + 48 <= bb.length; off++) {
      const b = packBytes(bb, off, 6);
      const stored = (b[4]! << 8) | b[5]!;
      if (stored !== crc16(b, 0, 4, 0x8005, 0) && stored !== crc16(b, 0, 4, 0x8050, 0)) continue;
      const ev = b[3]!;
      const id = ((b[0]! & 0x0f) << 16) | (b[1]! << 8) | b[2]!;
      const state =
        [
          ev & 0x80 ? "open" : "closed",
          ev & 0x40 ? "tamper" : "",
          ev & 0x08 ? "batt-low" : "",
          ev & 0x04 ? "heartbeat" : "",
        ]
          .filter(Boolean)
          .join(" ");
      return {
        bits: 48,
        code: hex(b),
        deviceId: id.toString(16).padStart(5, "0"),
        channel: (b[0]! >> 4).toString(),
        batteryLow: (ev & 0x08) !== 0,
        data: state,
      };
    }
  }
  return null;
}

/**
 * Fine Offset / Ecowitt WH25 / WH32 (FSK, NRZ). After the 0xAA…2DD4 sync, 8 bytes:
 *   b0: model(0xE) + id hi   b1: id lo + batt + invalid + temp hi(2)
 *   b2: temp lo   b3: humidity   b4-5: pressure ×0.1 hPa
 *   b6: byte-sum(b0..b5)   b7: xor(b0..b5) with nibbles swapped
 * The FSK mark/space polarity is unknown, so we try the NRZ bits and their inverse.
 * Guarded by the model nibble + both check bytes (a 20-bit guard) → immediate.
 */
function decodeFineOffset(b0: Burst): Decoded | null {
  for (const inv of [false, true]) {
    const bits = inv ? b0.nrz.map((x) => x ^ 1) : b0.nrz;
    for (let off = 0; off + 64 <= bits.length; off++) {
      const b = packBytes(bits, off, 8);
      if ((b[0]! >> 4) !== 0xe) continue; // model nibble
      if (byteSum(b, 0, 6) !== b[6]!) continue;
      let x = 0;
      for (let k = 0; k < 6; k++) x ^= b[k]!;
      if ((((x & 0x0f) << 4) | (x >> 4)) !== b[7]!) continue;
      if ((b[1]! >> 2) & 1) continue; // invalid-reading flag
      const tempRaw = ((b[1]! & 0x03) << 8) | b[2]!;
      const tempC = Math.round((tempRaw - 400)) / 10;
      const humidity = b[3]!;
      if (tempC < -40 || tempC > 70 || humidity > 100) continue;
      const id = ((b[0]! & 0x0f) << 4) | (b[1]! >> 4);
      const pressureHpa = Math.round(((b[4]! << 8) | b[5]!) * 0.1 * 10) / 10;
      return {
        bits: 64,
        code: hex(b),
        deviceId: id.toString(16).padStart(2, "0"),
        tempC,
        humidityPct: humidity,
        pressureHpa: pressureHpa > 0 && pressureHpa < 1100 ? pressureHpa : undefined,
        batteryLow: ((b[1]! >> 3) & 1) === 0,
        data: `${tempC}°C ${humidity}%`,
      };
    }
  }
  return null;
}

// Toyota TPMS preamble 0xa9e0 as raw FSK chips.
const TOYOTA_SYNC = [1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0];

/**
 * Toyota TPMS (315/433 MHz, FSK, differential Manchester). After the 0xa9e0
 * preamble, 72 DMC bits → 9 bytes: id(0-3), pressure(b4/b5), temperature(b5/b6),
 * CRC-8(b8, poly 0x07 init 0x80 over b0–b7). FSK mark/space polarity is unknown,
 * so we try the chips and their inverse. Sync match + CRC together are immediate.
 */
function decodeToyotaTpms(b0: Burst): Decoded | null {
  const chips = b0.nrz;
  for (const inv of [false, true]) {
    const c = inv ? chips.map((x) => x ^ 1) : chips;
    const s = findBits(c, TOYOTA_SYNC);
    if (s < 0) continue;
    const dmc = diffManchester(c, s + TOYOTA_SYNC.length);
    if (!dmc || dmc.length < 72) continue;
    const b = packBytes(dmc, 0, 9);
    if (crc8(b, 0, 8, 0x07, 0x80) !== b[8]!) continue;
    const id = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    const praw = ((b[4]! & 0x7f) << 1) | (b[5]! >> 7);
    const traw = ((b[5]! & 0x7f) << 1) | (b[6]! >> 7);
    const pressureKpa = Math.round((praw * 0.25 - 7.0) * 6.89476 * 10) / 10;
    const tempC = traw - 40;
    if (tempC < -40 || tempC > 120) continue;
    return {
      bits: 72,
      code: hex(b),
      deviceId: id.toString(16).padStart(8, "0"),
      tempC,
      pressureKpa: pressureKpa > 0 ? pressureKpa : undefined,
      data: `${pressureKpa > 0 ? `${pressureKpa.toFixed(0)} kPa ` : ""}${tempC}°C`,
    };
  }
  return null;
}

/** Generic PWM fallback: slice every pulse/gap pair (long pulse = 1) to bits. */
function decodeGeneric(pulses: number[], gaps: number[]): Decoded | null {
  const n = Math.min(pulses.length, gaps.length);
  if (n < MIN_PULSES) return null;
  let bits = "";
  for (let i = 0; i < n; i++) bits += pulses[i]! > gaps[i]! ? "1" : "0";
  return { bits: n, code: bitsToHex(bits) };
}

function bitsToHex(bits: string): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nib = bits.slice(i, i + 4).padEnd(4, "0");
    hex += parseInt(nib, 2).toString(16);
  }
  return hex;
}
