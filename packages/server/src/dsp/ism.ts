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

export class IsmReceiver {
  private floor = 1e-3;
  private on = false;
  private run = 0; // samples in the current on/off run
  private peak = 0; // peak |z|² seen in the current packet
  private pulses: number[] = [];
  private gaps: number[] = [];

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

  private decode(pulses: number[], gaps: number[], snr: number) {
    // Slice the PWM bitstream once (bit = pulse longer than its gap); the named
    // sensor decoders scan it for a CRC-valid frame, tolerating any leading sync
    // bits. A passing checksum/parity is what turns hex noise into real values.
    const bits = sliceBitsPwm(pulses, gaps);

    const acu = decodeAcurite(bits);
    if (acu) return this.emitDecoded("Acurite-Tower", acu, snr, true);

    const lac = decodeLaCrosse(bits);
    // Digest-only, no constant guard → trust it only once it repeats.
    if (lac) return this.emitDecoded("LaCrosse-TX", lac, snr, false);

    const ev = decodeEv1527(pulses, gaps);
    if (ev) return this.emitDecoded("EV1527", ev, snr, true);

    const g = decodeGeneric(pulses, gaps);
    if (g)
      this.emit(
        { model: "OOK", protocol: "PWM", bits: g.bits, code: g.code, snrDb: snr },
        false,
      );
  }

  private emitDecoded(model: string, d: Decoded, snrDb: number, trusted: boolean) {
    this.decoded++;
    this.emit(
      {
        model,
        protocol: "PWM",
        bits: d.bits,
        code: d.code,
        snrDb,
        deviceId: d.deviceId,
        data: d.data,
        channel: d.channel,
        tempC: d.tempC,
        humidityPct: d.humidityPct,
        batteryLow: d.batteryLow,
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
}

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
function decodeAcurite(bits: number[]): Decoded | null {
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
function decodeLaCrosse(bits: number[]): Decoded | null {
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
function decodeEv1527(pulses: number[], gaps: number[]): Decoded | null {
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
