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
  // key (model:code) -> event, to collapse a device's repeated transmissions.
  private recent = new Map<string, IsmEvent>();

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
    const ev = decodeEv1527(pulses, gaps);
    if (ev) {
      this.decoded++;
      this.emit("EV1527", "PWM", ev.bits, ev.code, snr, ev.deviceId, ev.data);
      return;
    }
    const g = decodeGeneric(pulses, gaps);
    if (g) this.emit("OOK", "PWM", g.bits, g.code, snr);
  }

  private emit(
    model: string,
    protocol: string,
    bits: number,
    code: string,
    snrDb: number,
    deviceId?: string,
    data?: string,
  ) {
    const now = Date.now();
    const key = `${model}:${code}`;
    const prev = this.recent.get(key);
    if (prev && now - prev.time < DEDUP_MS) {
      prev.repeats++;
      prev.time = now;
      prev.snrDb = snrDb;
      return; // fold into the existing event; client updates it by id
    }
    const event: IsmEvent = {
      id: this.nextId++,
      time: now,
      model,
      protocol,
      bits,
      code,
      deviceId,
      data,
      repeats: 1,
      snrDb,
    };
    this.recent.set(key, event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    // Drop stale dedup keys so the map can't grow without bound.
    if (this.recent.size > 256) {
      for (const [k, e] of this.recent)
        if (now - e.time > DEDUP_MS) this.recent.delete(k);
    }
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
