// APRS (Automatic Packet Reporting System) receiver. In North America APRS is
// 1200-baud Bell-202 AFSK (1200 Hz "mark" / 2200 Hz "space" audio tones) inside
// an NBFM channel on 144.390 MHz, carrying AX.25 UI frames. Those frames use the
// same HDLC framing as AIS (0x7E flags, NRZI, bit-stuffing, X.25 FCS), so we
// reuse the AIS deframer and only add the AFSK front-end and AX.25/APRS parsing.
//
// Pipeline:
//   NCO shift the channel off the DC spike -> DC  ->  decimate 240 k -> 48 k
//   -> FM discriminator (recovers the audio tones) -> Bell-202 mark/space
//   correlator (soft bit) -> low-pass -> DPLL bit sync -> NRZI + HDLC deframe
//   -> X.25 FCS check -> AX.25 address/info parse -> APRS position parse.
//
// Position parsing covers the common formats: uncompressed lat/lon, Base-91
// compressed, and MIC-E (latitude packed into the AX.25 destination callsign,
// longitude/course/speed in the information field) — the last being what most
// mobile trackers transmit.

import {
  APRS_SAMPLE_RATE,
  APRS_IF_OFFSET,
  type StationReport,
} from "@sdr/shared";
import { Nco } from "./nco";
import { ComplexDecimator, RealFir, designLowpass, tapsFor } from "./filters";
import { HdlcDeframer, checkFrame } from "./ais";

const BAUD = 1200;
const DECIM = 5; // 240 kSPS -> 48 kSPS
const BB_RATE = APRS_SAMPLE_RATE / DECIM; // 48 kHz baseband
const SPS = BB_RATE / BAUD; // 40 samples per symbol
const MARK_HZ = 1200;
const SPACE_HZ = 2200;

const STALE_MS = 1_800_000; // drop stations not heard from in 30 min
const DC_ALPHA = 0.01; // discriminator DC-blocker corner (~76 Hz @ 48 kHz)
const SNR_GATE = 1.5; // burst envelope must clear the noise floor by ~3.5 dB

interface Station {
  call: string;
  lat?: number;
  lon?: number;
  course?: number;
  speed?: number;
  altitude?: number;
  symbol?: string;
  comment?: string;
  via?: string;
  kind: string;
  message?: string;
  packets: number;
  lastSeen: number;
}

export class AprsReceiver {
  private nco = new Nco(APRS_SAMPLE_RATE, -APRS_IF_OFFSET);
  private decim = new ComplexDecimator(
    designLowpass(tapsFor(0.03), 0.05), // ~12 kHz cutoff @ 240 k
    DECIM,
  );
  private afsk = new AfskCorrelator();
  private shaping = new RealFir(designLowpass(31, BAUD / 2 / BB_RATE));
  private hdlc: HdlcDeframer;
  // FM discriminator state.
  private prevI = 0;
  private prevQ = 0;
  private dcMean = 0;
  // DPLL bit-clock state.
  private pll = 0;
  private prevSign = 1;
  // Envelope vs noise floor (fast / slow EMAs of |z|).
  private env = 0;
  private floor = 0;
  private candidateCount = 0;

  private stations = new Map<string, Station>();
  private decoded = 0;

  constructor() {
    this.hdlc = new HdlcDeframer(
      (bytes) => this.handleFrame(bytes),
      () => {
        if (this.env > this.floor * SNR_GATE) this.candidateCount++;
      },
    );
  }

  get totalMessages(): number {
    return this.decoded;
  }
  /** Well-formed AX.25 bursts seen (valid FCS or not) — an activity gauge. */
  get candidateFrames(): number {
    return this.candidateCount;
  }

  reset() {
    this.stations.clear();
    this.prevI = 0;
    this.prevQ = 0;
    this.dcMean = 0;
    this.pll = 0;
    this.prevSign = 1;
    this.env = 0;
    this.floor = 0;
    this.candidateCount = 0;
    this.afsk.reset();
    this.hdlc.reset();
  }

  /** `iq` is interleaved complex at APRS_SAMPLE_RATE. */
  process(iq: Float32Array) {
    const shifted = this.nco.mix(iq, new Float32Array(iq.length));
    const bb = this.decim.process(shifted); // interleaved complex @ 48 kHz
    const n = bb.length >> 1;

    // FM discriminator -> audio tones; then AFSK correlate to a soft bit value.
    const soft = new Float32Array(n);
    let pi = this.prevI;
    let pq = this.prevQ;
    for (let k = 0; k < n; k++) {
      const i = bb[2 * k]!;
      const q = bb[2 * k + 1]!;
      const re = i * pi + q * pq;
      const im = q * pi - i * pq;
      let d = Math.atan2(im, re);
      this.dcMean += DC_ALPHA * (d - this.dcMean);
      d -= this.dcMean;
      soft[k] = this.afsk.push(d);
      const mag = Math.sqrt(i * i + q * q);
      this.env += 0.02 * (mag - this.env);
      this.floor += 0.0002 * (mag - this.floor);
      pi = i;
      pq = q;
    }
    this.prevI = pi;
    this.prevQ = pq;

    const filt = this.shaping.process(soft);
    this.clockAndSlice(filt);
  }

  snapshot(now: number): StationReport[] {
    const out: StationReport[] = [];
    for (const [call, s] of this.stations) {
      if (now - s.lastSeen > STALE_MS) {
        this.stations.delete(call);
        continue;
      }
      out.push({
        call: s.call,
        lat: s.lat,
        lon: s.lon,
        course: s.course,
        speed: s.speed,
        altitude: s.altitude,
        symbol: s.symbol,
        comment: s.comment,
        via: s.via,
        kind: s.kind,
        message: s.message,
        packets: s.packets,
        seen: (now - s.lastSeen) / 1000,
      });
    }
    return out;
  }

  // DPLL symbol-clock recovery (identical scheme to AIS, retuned for 1200 baud):
  // accumulate phase at the baud rate, emit a symbol on wrap, nudge the phase to
  // the symbol centre on each zero-crossing.
  private clockAndSlice(x: Float32Array) {
    const STEP = 1 / SPS;
    const GAIN = 0.25;
    let pll = this.pll;
    let prevSign = this.prevSign;
    for (let k = 0; k < x.length; k++) {
      const s = x[k]!;
      const sign = s >= 0 ? 1 : -1;
      if (sign !== prevSign) pll += GAIN * (0.5 - pll);
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

  private handleFrame(bytes: Uint8Array) {
    const frame = parseAx25(bytes);
    if (!frame) return;
    this.decoded++;
    const now = Date.now();
    let s = this.stations.get(frame.source);
    if (!s) {
      s = { call: frame.source, kind: "other", packets: 0, lastSeen: now };
      this.stations.set(frame.source, s);
    }
    s.packets++;
    s.lastSeen = now;
    s.via = frame.digis.length ? frame.digis.join(",") : undefined;

    const p = parseAprsInfo(frame.info, frame.destChars);
    if (!p) return;
    s.kind = p.kind;
    if (p.lat != null && p.lon != null) {
      s.lat = p.lat;
      s.lon = p.lon;
    }
    if (p.course != null) s.course = p.course;
    if (p.speed != null) s.speed = p.speed;
    if (p.altitude != null) s.altitude = p.altitude;
    if (p.symbol) s.symbol = p.symbol;
    if (p.comment) s.comment = p.comment;
    if (p.message) s.message = p.message;
  }
}

// ---------------------------------------------------------------------------
// Bell-202 AFSK correlator: a sliding one-symbol matched filter for the mark
// (1200 Hz) and space (2200 Hz) tones. The soft output is |mark| - |space|, so
// positive means mark, negative means space.
// ---------------------------------------------------------------------------

class AfskCorrelator {
  private readonly N = Math.round(SPS);
  private buf = new Float32Array(this.N);
  private pos = 0;
  private cosM = new Float32Array(this.N);
  private sinM = new Float32Array(this.N);
  private cosS = new Float32Array(this.N);
  private sinS = new Float32Array(this.N);

  constructor() {
    for (let j = 0; j < this.N; j++) {
      const wm = (2 * Math.PI * MARK_HZ * j) / BB_RATE;
      const ws = (2 * Math.PI * SPACE_HZ * j) / BB_RATE;
      this.cosM[j] = Math.cos(wm);
      this.sinM[j] = Math.sin(wm);
      this.cosS[j] = Math.cos(ws);
      this.sinS[j] = Math.sin(ws);
    }
  }

  reset() {
    this.buf.fill(0);
    this.pos = 0;
  }

  push(x: number): number {
    this.buf[this.pos] = x;
    this.pos = (this.pos + 1) % this.N;
    let mI = 0;
    let mQ = 0;
    let sI = 0;
    let sQ = 0;
    // Walk the window oldest -> newest so the tone tables stay phase-aligned.
    for (let j = 0; j < this.N; j++) {
      const v = this.buf[(this.pos + j) % this.N]!;
      mI += v * this.cosM[j]!;
      mQ += v * this.sinM[j]!;
      sI += v * this.cosS[j]!;
      sQ += v * this.sinS[j]!;
    }
    return Math.sqrt(mI * mI + mQ * mQ) - Math.sqrt(sI * sI + sQ * sQ);
  }
}

// ---------------------------------------------------------------------------
// AX.25 framing
// ---------------------------------------------------------------------------

interface Ax25Frame {
  dest: string; // destination address (callsign-ssid)
  destChars: string; // raw 6 destination characters (for MIC-E latitude)
  source: string;
  digis: string[];
  control: number;
  pid: number;
  info: Uint8Array;
}

/**
 * Parse a de-framed AX.25 packet (logical bytes, FCS already stripped). Address
 * bytes carry 7-bit ASCII shifted left by one; the low bit of each SSID octet is
 * the address-extension flag (set on the final address). Returns null if it
 * isn't a well-formed UI frame.
 */
export function parseAx25(b: Uint8Array): Ax25Frame | null {
  if (b.length < 16) return null;
  const addrs: { call: string; ssid: number; last: boolean }[] = [];
  let raw = "";
  let p = 0;
  for (let n = 0; n < 10; n++) {
    if (p + 7 > b.length) return null;
    let call = "";
    for (let i = 0; i < 6; i++) call += String.fromCharCode((b[p + i]! >> 1) & 0x7f);
    if (n === 0) raw = call; // keep the destination's raw chars for MIC-E
    const ssidByte = b[p + 6]!;
    addrs.push({
      call: call.replace(/\s+$/, ""),
      ssid: (ssidByte >> 1) & 0x0f,
      last: (ssidByte & 1) === 1,
    });
    p += 7;
    if (addrs[addrs.length - 1]!.last) break;
  }
  if (addrs.length < 2 || p + 2 > b.length) return null;
  const control = b[p++]!;
  const pid = b[p++]!;
  // UI frame control = 0x03 (P/F bit may set 0x13). Anything else isn't APRS.
  if ((control & ~0x10) !== 0x03) return null;
  const fmt = (a: { call: string; ssid: number }) =>
    a.ssid ? `${a.call}-${a.ssid}` : a.call;
  return {
    dest: fmt(addrs[0]!),
    destChars: raw,
    source: fmt(addrs[1]!),
    digis: addrs.slice(2).map(fmt),
    control,
    pid,
    info: b.subarray(p),
  };
}

// ---------------------------------------------------------------------------
// APRS information-field parsing
// ---------------------------------------------------------------------------

interface AprsPos {
  kind: string;
  lat?: number;
  lon?: number;
  course?: number;
  speed?: number;
  altitude?: number;
  symbol?: string;
  comment?: string;
  message?: string;
}

function bytesToStr(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Strip control characters and trailing whitespace from a comment string. */
function cleanComment(s: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return t.length ? t : undefined;
}

export function parseAprsInfo(
  info: Uint8Array,
  destChars: string,
): AprsPos | null {
  if (info.length === 0) return null;
  const type = String.fromCharCode(info[0]!);
  const text = bytesToStr(info);

  switch (type) {
    case "!":
    case "=":
      return parsePosition(text.slice(1), false);
    case "/":
    case "@":
      return parsePosition(text.slice(8), true); // skip 7-char timestamp
    case "`":
    case "'":
      return parseMicE(destChars, info);
    case ";":
      return parseObject(text);
    case ">":
      return { kind: "status", comment: cleanComment(text.slice(1)) };
    case ":":
      return { kind: "message", message: cleanComment(text.slice(1)) };
    default:
      return { kind: "other", comment: cleanComment(text.slice(1)) };
  }
}

/** Decide compressed vs uncompressed and parse, then pull course/speed/alt. */
function parsePosition(s: string, timestamped: boolean): AprsPos | null {
  const kind = "position";
  if (s.length < 1) return null;
  const first = s.charCodeAt(0);
  const base: AprsPos =
    first >= 0x30 && first <= 0x39
      ? parseUncompressed(s)
      : parseCompressed(s);
  if (base) base.kind = kind;
  void timestamped;
  return base;
}

function parseUncompressed(s: string): AprsPos {
  const out: AprsPos = { kind: "position" };
  if (s.length < 19) return out;
  const latDeg = parseInt(s.slice(0, 2), 10);
  const latMin = parseFloat(s.slice(2, 7));
  const ns = s[7]!;
  const symTable = s[8]!;
  const lonDeg = parseInt(s.slice(9, 12), 10);
  const lonMin = parseFloat(s.slice(12, 17));
  const ew = s[17]!;
  const symCode = s[18]!;
  if (Number.isFinite(latDeg) && Number.isFinite(latMin)) {
    let lat = latDeg + latMin / 60;
    if (ns === "S" || ns === "s") lat = -lat;
    let lon = lonDeg + lonMin / 60;
    if (ew === "W" || ew === "w") lon = -lon;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.lat = lat;
      out.lon = lon;
      out.symbol = symTable + symCode;
    }
  }
  applyExtensions(out, s.slice(19));
  return out;
}

function parseCompressed(s: string): AprsPos {
  const out: AprsPos = { kind: "position" };
  if (s.length < 13) return out;
  const symTable = s[0]!;
  const y = base91(s.slice(1, 5));
  const x = base91(s.slice(5, 9));
  const symCode = s[9]!;
  const lat = 90 - y / 380926;
  const lon = -180 + x / 190463;
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat;
    out.lon = lon;
    out.symbol = symTable + symCode;
  }
  // Compression-type byte (s[12]) says what the two cs bytes mean; we decode the
  // common course/speed case and leave altitude/range to the comment.
  const c = s.charCodeAt(10) - 33;
  const sp = s.charCodeAt(11) - 33;
  if (s[10] !== " " && c >= 0 && c <= 89) {
    out.course = c * 4;
    out.speed = Math.round(Math.pow(1.08, sp) - 1);
  }
  applyExtensions(out, s.slice(13));
  return out;
}

function base91(t: string): number {
  let v = 0;
  for (let i = 0; i < t.length; i++) v = v * 91 + (t.charCodeAt(i) - 33);
  return v;
}

/** Pull a `CSE/SPD` data extension and a `/A=dddddd` altitude from the comment. */
function applyExtensions(out: AprsPos, rest: string) {
  const cs = rest.match(/^(\d{3})\/(\d{3})/);
  if (cs) {
    const crs = parseInt(cs[1]!, 10);
    const spd = parseInt(cs[2]!, 10);
    if (out.course == null && crs > 0) out.course = crs;
    if (out.speed == null) out.speed = spd; // knots
    rest = rest.slice(7);
  }
  const alt = rest.match(/\/A=(\d{6})/);
  if (alt) out.altitude = parseInt(alt[1]!, 10); // already feet
  out.comment = cleanComment(rest.replace(/\/A=\d{6}/, ""));
}

/** Type ";" object report: name(9) + live/kill + timestamp(7) + position. */
function parseObject(text: string): AprsPos | null {
  if (text.length < 18) return null;
  const out = parsePosition(text.slice(18), true);
  if (out) out.kind = "object";
  return out;
}

/**
 * MIC-E: latitude (+ N/S, longitude offset, W/E flags) is packed into the six
 * destination-callsign characters; longitude, speed and course live in the
 * first six information-field bytes, the symbol in the next two, and an optional
 * Base-91 altitude as `xxx}`. Algorithm per APRS101 / aprs-python.
 */
export function parseMicE(destChars: string, info: Uint8Array): AprsPos | null {
  if (destChars.length < 6 || info.length < 9) return null;
  const d = destChars;

  // Destination chars -> latitude digits (A-J and P-Y both map to 0-9).
  let latStr = "";
  for (let i = 0; i < 6; i++) {
    const c = d.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) latStr += d[i];
    else if (c >= 0x41 && c <= 0x4a) latStr += String.fromCharCode(c - 17);
    else if (c >= 0x50 && c <= 0x59) latStr += String.fromCharCode(c - 32);
    else if (c === 0x4b || c === 0x4c || c === 0x5a) latStr += " ";
    else return null;
  }
  const latDeg = parseInt(latStr.slice(0, 2).replace(/ /g, "0"), 10);
  const latMin = parseFloat(
    (latStr.slice(2, 4) + "." + latStr.slice(4, 6)).replace(/ /g, "0"),
  );
  if (!Number.isFinite(latDeg) || !Number.isFinite(latMin)) return null;
  let lat = latDeg + latMin / 60;
  if (d.charCodeAt(3) <= 0x4c) lat = -lat; // N/S: <= 'L' is South

  // Longitude from info bytes (info[0] is the data-type id; body starts at [1]).
  let lonDeg = info[1]! - 28;
  if (d.charCodeAt(4) >= 0x50) lonDeg += 100; // longitude offset
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = info[2]! - 28;
  if (lonMin >= 60) lonMin -= 60;
  lonMin += (info[3]! - 28) / 100;
  let lon = lonDeg + lonMin / 60;
  if (d.charCodeAt(5) >= 0x50) lon = -lon; // W/E: >= 'P' is West

  // Speed (knots) and course (degrees) from the next three bytes.
  let speed = (info[4]! - 28) * 10;
  let course = info[5]! - 28;
  const q = Math.floor(course / 10);
  course = (course - q * 10) * 100 + (info[6]! - 28);
  speed += q;
  if (speed >= 800) speed -= 800;
  if (course >= 400) course -= 400;

  const symbol = String.fromCharCode(info[8]!) + String.fromCharCode(info[7]!);

  const out: AprsPos = { kind: "mic-e", symbol };
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat;
    out.lon = lon;
  }
  if (speed > 0) out.speed = speed;
  out.course = course;

  // Optional altitude: three Base-91 chars immediately before a "}".
  const tail = bytesToStr(info.subarray(9));
  const brace = tail.indexOf("}");
  if (brace >= 3) {
    const m =
      (tail.charCodeAt(brace - 3) - 33) * 8281 +
      (tail.charCodeAt(brace - 2) - 33) * 91 +
      (tail.charCodeAt(brace - 1) - 33) -
      10000;
    if (m > -1000 && m < 30000) out.altitude = Math.round(m * 3.28084); // feet
    out.comment = cleanComment(tail.slice(brace + 1));
  } else {
    out.comment = cleanComment(tail);
  }
  return out;
}
