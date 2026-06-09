// AIS (marine AIS, ITU-R M.1371) receiver. AIS is 9600-baud GMSK on two VHF
// channels — 161.975 MHz (A) and 162.025 MHz (B), 50 kHz apart — carrying HDLC
// frames (training + flag + payload + FCS + flag) of NRZI-encoded, bit-stuffed
// data. The payload is a 6-bit-packed message (position reports, static/voyage
// data, …) keyed by a 9-digit MMSI.
//
// Pipeline, per channel (both run on the same captured IQ):
//   NCO shift channel -> DC  ->  decimate 240 k -> 48 k (5 samples/symbol)
//   -> FM/GMSK discriminator -> matched low-pass -> DPLL bit sync
//   -> NRZI decode -> HDLC deframe (flag detect + de-stuff) -> X.25 FCS check
//   -> 6-bit field extraction -> vessel table update.
//
// The session tunes to 162.000 MHz @ 240 kSPS so a single capture covers both
// channels; it polls snapshot() periodically to broadcast the vessel table.

import {
  AIS_CHANNELS,
  AIS_SAMPLE_RATE,
  type VesselReport,
} from "@sdr/shared";
import { Nco } from "./nco";
import { ComplexDecimator, RealFir, designLowpass, tapsFor } from "./filters";

const BAUD = 9600;
const DECIM = 5; // 240 kSPS -> 48 kSPS
const BB_RATE = AIS_SAMPLE_RATE / DECIM; // 48 kHz baseband
const SPS = BB_RATE / BAUD; // 5 samples per symbol

const STALE_MS = 600_000; // drop vessels not heard from in 10 min (ships are slow)
const MAX_FRAME_BITS = 1024; // guard against runaway frames
// DC-blocker corner for the discriminator output (~76 Hz @ 48 kHz). Removes the
// constant frequency bias a tuner offset adds, so the bit slicer stays centred.
const DC_ALPHA = 0.01;

interface Vessel {
  mmsi: string;
  name?: string;
  callsign?: string;
  shipType?: string;
  lat?: number;
  lon?: number;
  sog?: number;
  cog?: number;
  heading?: number;
  navStatus?: string;
  channel?: "A" | "B";
  rssi?: number;
  classB?: boolean;
  messages: number;
  lastSeen: number;
}

export class AisReceiver {
  private vessels = new Map<string, Vessel>();
  private chA: ChannelDemod;
  private chB: ChannelDemod;
  private decoded = 0;

  constructor() {
    const onFrame = (bytes: Uint8Array, channel: "A" | "B", rssi: number) =>
      this.handleFrame(bytes, channel, rssi);
    this.chA = new ChannelDemod(AIS_CHANNELS.A, "A", onFrame);
    this.chB = new ChannelDemod(AIS_CHANNELS.B, "B", onFrame);
  }

  get totalMessages(): number {
    return this.decoded;
  }

  /** Well-formed frames seen on either channel (valid CRC or not). */
  get candidateFrames(): number {
    return this.chA.candidates + this.chB.candidates;
  }

  reset() {
    this.vessels.clear();
    this.chA.reset();
    this.chB.reset();
  }

  /** `iq` is interleaved complex at AIS_SAMPLE_RATE. */
  process(iq: Float32Array) {
    this.chA.process(iq);
    this.chB.process(iq);
  }

  snapshot(now: number): VesselReport[] {
    const out: VesselReport[] = [];
    for (const [mmsi, v] of this.vessels) {
      if (now - v.lastSeen > STALE_MS) {
        this.vessels.delete(mmsi);
        continue;
      }
      out.push({
        mmsi: v.mmsi,
        name: v.name,
        callsign: v.callsign,
        shipType: v.shipType,
        lat: v.lat,
        lon: v.lon,
        sog: v.sog,
        cog: v.cog,
        heading: v.heading,
        navStatus: v.navStatus,
        channel: v.channel,
        rssi: v.rssi != null ? Math.round(v.rssi * 10) / 10 : undefined,
        classB: v.classB,
        messages: v.messages,
        seen: (now - v.lastSeen) / 1000,
      });
    }
    return out;
  }

  // --- decoded-frame handling ---------------------------------------------

  /** A valid (CRC-checked) HDLC payload. `bytes` are the logical message bytes. */
  private handleFrame(bytes: Uint8Array, channel: "A" | "B", rssi: number) {
    if (bytes.length < 2) return;
    const type = getBits(bytes, 0, 6);
    const mmsi = getBits(bytes, 8, 30);
    if (mmsi === 0) return;
    const id = String(mmsi).padStart(9, "0");
    const now = Date.now();

    let v = this.vessels.get(id);
    if (!v) {
      v = { mmsi: id, messages: 0, lastSeen: now };
      this.vessels.set(id, v);
    }
    this.decoded++;
    v.messages++;
    v.lastSeen = now;
    v.channel = channel;
    v.rssi = v.rssi == null ? rssi : v.rssi * 0.7 + rssi * 0.3;

    switch (type) {
      case 1:
      case 2:
      case 3:
        decodePositionA(v, bytes);
        break;
      case 4:
        decodeBaseStation(v, bytes);
        break;
      case 5:
        decodeStaticA(v, bytes);
        break;
      case 18:
        decodePositionB(v, bytes);
        break;
      case 19:
        decodePositionB(v, bytes);
        decodeStaticExtB(v, bytes);
        break;
      case 24:
        decodeStaticB(v, bytes);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-channel GMSK demodulator + HDLC deframer
// ---------------------------------------------------------------------------

type FrameSink = (bytes: Uint8Array, channel: "A" | "B", rssi: number) => void;

class ChannelDemod {
  private nco: Nco;
  private decim: ComplexDecimator;
  private matched: RealFir;
  private hdlc: HdlcDeframer;
  // FM discriminator state (last baseband sample).
  private prevI = 0;
  private prevQ = 0;
  // DPLL bit-clock state.
  private pll = 0;
  private prevSign = 1;
  // Running mean of the discriminator output (removed before slicing).
  private dcMean = 0;
  // Rolling signal estimate (mean |z|), stamped onto decoded frames.
  private magAvg = 0;

  constructor(
    offsetHz: number,
    private channel: "A" | "B",
    private sink: FrameSink,
  ) {
    this.nco = new Nco(AIS_SAMPLE_RATE, -offsetHz); // bring channel down to DC
    const taps = designLowpass(tapsFor(0.03), 0.05); // ~12 kHz cutoff @ 240 k
    this.decim = new ComplexDecimator(taps, DECIM);
    // Matched-ish receive filter: low-pass the discriminator near half the baud.
    this.matched = new RealFir(designLowpass(31, BAUD / 2 / BB_RATE));
    this.hdlc = new HdlcDeframer((bytes) => {
      const rssi = 20 * Math.log10(Math.max(this.magAvg, 1e-4));
      this.sink(bytes, this.channel, rssi);
    });
  }

  reset() {
    this.prevI = 0;
    this.prevQ = 0;
    this.pll = 0;
    this.prevSign = 1;
    this.dcMean = 0;
    this.magAvg = 0;
    this.hdlc.reset();
  }

  get candidates(): number {
    return this.hdlc.candidates;
  }

  process(iq: Float32Array) {
    // Shift this channel to DC (on a copy — the other channel reads the same IQ).
    const shifted = this.nco.mix(iq, new Float32Array(iq.length));
    const bb = this.decim.process(shifted); // interleaved complex @ 48 kHz
    const n = bb.length >> 1;

    // FM discriminator: instantaneous frequency = arg(z[k] · conj(z[k-1])).
    const demod = new Float32Array(n);
    let pi = this.prevI;
    let pq = this.prevQ;
    for (let k = 0; k < n; k++) {
      const i = bb[2 * k]!;
      const q = bb[2 * k + 1]!;
      const re = i * pi + q * pq;
      const im = q * pi - i * pq;
      const d = Math.atan2(im, re);
      this.dcMean += DC_ALPHA * (d - this.dcMean);
      demod[k] = d - this.dcMean; // remove carrier-offset bias
      const mag = Math.sqrt(i * i + q * q);
      this.magAvg += 0.001 * (mag - this.magAvg);
      pi = i;
      pq = q;
    }
    this.prevI = pi;
    this.prevQ = pq;

    const filt = this.matched.process(demod);
    this.clockAndSlice(filt);
  }

  // DPLL symbol-clock recovery: accumulate phase at the baud rate and emit a
  // symbol each time it wraps; on every zero-crossing nudge the phase so the
  // wrap lands at the symbol centre (half a symbol from the transition).
  private clockAndSlice(x: Float32Array) {
    const STEP = 1 / SPS;
    const GAIN = 0.25;
    let pll = this.pll;
    let prevSign = this.prevSign;
    for (let k = 0; k < x.length; k++) {
      const s = x[k]!;
      const sign = s >= 0 ? 1 : -1;
      if (sign !== prevSign) pll += GAIN * (0.5 - pll); // re-centre on transition
      prevSign = sign;
      pll += STEP;
      if (pll >= 1) {
        pll -= 1;
        this.hdlc.push(sign > 0 ? 1 : 0);
      }
    }
    this.pll = pll;
    this.prevSign = prevSign;
  }
}

// ---------------------------------------------------------------------------
// NRZI + HDLC bit-level deframer
// ---------------------------------------------------------------------------

/**
 * Consumes raw symbol levels (0/1), performs NRZI decoding (a 0 bit is sent as
 * a level transition — so polarity inversion doesn't matter), detects the 0x7E
 * HDLC flag, removes stuffed zeros, and emits each CRC-valid frame's logical
 * message bytes. Exposed for the self-test.
 */
export class HdlcDeframer {
  private lastLevel = 0;
  private bits: number[] = [];
  private ones = 0;
  private shiftReg = 0;
  private inFrame = false;
  /** Count of well-formed (flag-delimited, byte-aligned) frames seen, valid or
   * not — a rough "is AIS energy reaching the decoder?" activity gauge. */
  candidates = 0;

  constructor(private onFrame: (bytes: Uint8Array) => void) {}

  reset() {
    this.lastLevel = 0;
    this.bits = [];
    this.ones = 0;
    this.shiftReg = 0;
    this.inFrame = false;
    this.candidates = 0;
  }

  push(level: number) {
    const hdlcBit = level === this.lastLevel ? 1 : 0;
    this.lastLevel = level;

    this.shiftReg = ((this.shiftReg << 1) | hdlcBit) & 0xff;
    if (this.shiftReg === 0x7e) {
      // Flag (01111110): closes the current frame and opens the next. While in
      // a frame we will have already accumulated the flag's first 7 bits
      // (0111111) before recognising it on the trailing 0 — drop them.
      if (this.inFrame && this.bits.length >= 7) {
        const frame = this.bits.slice(0, this.bits.length - 7);
        if (frame.length >= 40 && frame.length % 8 === 0) this.candidates++;
        const bytes = checkFrame(frame);
        if (bytes) this.onFrame(bytes);
      }
      this.bits = [];
      this.ones = 0;
      this.inFrame = true;
      return;
    }
    if (!this.inFrame) return;

    if (hdlcBit === 1) {
      this.ones++;
      if (this.ones > 6) {
        // 7+ ones is never valid inside a frame (abort) — drop it.
        this.inFrame = false;
        this.bits = [];
        this.ones = 0;
        return;
      }
      this.bits.push(1);
    } else {
      if (this.ones === 5) {
        this.ones = 0; // stuffed zero — discard
      } else {
        this.ones = 0;
        this.bits.push(0);
      }
    }
    if (this.bits.length > MAX_FRAME_BITS) {
      this.inFrame = false;
      this.bits = [];
      this.ones = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// HDLC frame check + bit helpers
// ---------------------------------------------------------------------------

/**
 * Validate a de-stuffed, NRZI-decoded HDLC frame (data + 16-bit FCS, in
 * transmission order — LSB first per octet) and return the logical message
 * bytes (MSB first) if the X.25 / CRC-16-CCITT FCS checks out, else null.
 */
export function checkFrame(bits: number[]): Uint8Array | null {
  const n = bits.length;
  if (n < 40 || n % 8 !== 0) return null; // need a few bytes, byte-aligned
  const dataBits = n - 16;

  // CRC-16/X.25 (reflected, poly 0x1021 -> 0x8408) over the data bits, fed
  // LSB-first — which is exactly the on-air bit order.
  let crc = 0xffff;
  for (let i = 0; i < dataBits; i++) {
    const b = (bits[i]! ^ (crc & 1)) & 1;
    crc >>>= 1;
    if (b) crc ^= 0x8408;
  }
  crc = (crc ^ 0xffff) & 0xffff;

  let fcs = 0;
  for (let i = 0; i < 16; i++) fcs |= bits[dataBits + i]! << i; // LSB first
  if (crc !== (fcs & 0xffff)) return null;

  // Logical bytes: each octet is sent LSB first, so bit k is value 2^k.
  const nbytes = dataBits >> 3;
  const out = new Uint8Array(nbytes);
  for (let g = 0; g < nbytes; g++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v |= bits[g * 8 + k]! << k;
    out[g] = v;
  }
  return out;
}

/** Read `len` bits (MSB first) starting at bit `start` as an unsigned int. */
export function getBits(bytes: Uint8Array, start: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const bit = start + i;
    const byte = bytes[bit >> 3] ?? 0;
    v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
  }
  return v >>> 0;
}

/** Signed (two's complement) variant of getBits. */
function getInt(bytes: Uint8Array, start: number, len: number): number {
  const u = getBits(bytes, start, len);
  const sign = 1 << (len - 1);
  return u & sign ? u - (1 << len) : u;
}

// AIS 6-bit ASCII (ITU-R M.1371 Table 47): value 0..63 -> character.
const AIS6 =
  "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?";

/** Decode `chars` 6-bit characters starting at bit `start`, trimmed. */
function getText(bytes: Uint8Array, start: number, chars: number): string {
  let s = "";
  for (let i = 0; i < chars; i++) {
    const c = getBits(bytes, start + i * 6, 6);
    s += AIS6[c] ?? "";
  }
  return s.replace(/@+$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Message field decoders
// ---------------------------------------------------------------------------

const NAV_STATUS = [
  "Under way using engine",
  "At anchor",
  "Not under command",
  "Restricted manoeuvrability",
  "Constrained by draught",
  "Moored",
  "Aground",
  "Engaged in fishing",
  "Under way sailing",
  "Reserved (HSC)",
  "Reserved (WIG)",
  "Reserved",
  "Reserved",
  "Reserved",
  "AIS-SART",
  "Undefined",
];

function shipTypeLabel(code: number): string | undefined {
  if (code <= 0) return undefined;
  if (code >= 20 && code <= 29) return "Wing in ground";
  if (code === 30) return "Fishing";
  if (code === 31 || code === 32) return "Towing";
  if (code === 33) return "Dredging";
  if (code === 34) return "Diving";
  if (code === 35) return "Military";
  if (code === 36) return "Sailing";
  if (code === 37) return "Pleasure craft";
  if (code >= 40 && code <= 49) return "High-speed craft";
  if (code === 50) return "Pilot vessel";
  if (code === 51) return "Search & rescue";
  if (code === 52) return "Tug";
  if (code === 53) return "Port tender";
  if (code === 55) return "Law enforcement";
  if (code === 58) return "Medical transport";
  if (code >= 60 && code <= 69) return "Passenger";
  if (code >= 70 && code <= 79) return "Cargo";
  if (code >= 80 && code <= 89) return "Tanker";
  if (code >= 90 && code <= 99) return "Other";
  return "Other";
}

/** Longitude / latitude in 1/10000 minute; sentinel values mean "not available". */
function setPosition(v: Vessel, lon: number, lat: number) {
  const lo = lon / 600000;
  const la = lat / 600000;
  if (Math.abs(lo) <= 180 && Math.abs(la) <= 90) {
    v.lon = lo;
    v.lat = la;
  }
}

function setCourse(v: Vessel, sog: number, cog: number, heading: number) {
  if (sog !== 1023) v.sog = sog / 10;
  if (cog !== 3600) v.cog = cog / 10;
  if (heading !== 511) v.heading = heading;
}

// Types 1/2/3 — Class A position report.
function decodePositionA(v: Vessel, b: Uint8Array) {
  v.classB = false;
  v.navStatus = NAV_STATUS[getBits(b, 38, 4)];
  const sog = getBits(b, 50, 10);
  const lon = getInt(b, 61, 28);
  const lat = getInt(b, 89, 27);
  const cog = getBits(b, 116, 12);
  const heading = getBits(b, 128, 9);
  setPosition(v, lon, lat);
  setCourse(v, sog, cog, heading);
}

// Type 18 — Class B position report.
function decodePositionB(v: Vessel, b: Uint8Array) {
  v.classB = true;
  const sog = getBits(b, 46, 10);
  const lon = getInt(b, 57, 28);
  const lat = getInt(b, 85, 27);
  const cog = getBits(b, 112, 12);
  const heading = getBits(b, 124, 9);
  setPosition(v, lon, lat);
  setCourse(v, sog, cog, heading);
}

// Type 4 — base station report (position only).
function decodeBaseStation(v: Vessel, b: Uint8Array) {
  const lon = getInt(b, 79, 28);
  const lat = getInt(b, 107, 27);
  setPosition(v, lon, lat);
}

// Type 5 — Class A static and voyage data.
function decodeStaticA(v: Vessel, b: Uint8Array) {
  if (b.length * 8 < 240) return;
  v.classB = false;
  const callsign = getText(b, 70, 7);
  const name = getText(b, 112, 20);
  const shipType = shipTypeLabel(getBits(b, 232, 8));
  if (callsign) v.callsign = callsign;
  if (name) v.name = name;
  if (shipType) v.shipType = shipType;
}

// Type 19 — Class B extended (name + ship type alongside position).
function decodeStaticExtB(v: Vessel, b: Uint8Array) {
  if (b.length * 8 < 263) return;
  const name = getText(b, 143, 20);
  const shipType = shipTypeLabel(getBits(b, 263, 8));
  if (name) v.name = name;
  if (shipType) v.shipType = shipType;
}

// Type 24 — Class B static data, split across part A (name) and part B (type).
function decodeStaticB(v: Vessel, b: Uint8Array) {
  v.classB = true;
  const part = getBits(b, 38, 2);
  if (part === 0) {
    const name = getText(b, 40, 20);
    if (name) v.name = name;
  } else if (part === 1) {
    const shipType = shipTypeLabel(getBits(b, 40, 8));
    const callsign = getText(b, 90, 7);
    if (shipType) v.shipType = shipType;
    if (callsign) v.callsign = callsign;
  }
}
