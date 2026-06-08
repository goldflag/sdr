// ADS-B (1090 MHz Mode S) receiver. Ported from the classic dump1090 2 MHz
// demodulator: magnitude detect -> preamble search -> Manchester bit slice ->
// 24-bit Mode S CRC. Only DF17/DF18 extended-squitter frames are decoded (these
// carry the ADS-B identification, airborne position and velocity and have a
// zero CRC residual, so no address-overlay recovery is needed).
//
// Input is interleaved complex IQ at 2.0 MSPS (2 samples per Mode S bit),
// already at the dongle center (no VFO shift — ADS-B fills the whole 2 MHz span
// around 1090 MHz). The receiver maintains an aircraft table keyed by ICAO
// address; the session polls snapshot() periodically to broadcast it.

import type { AircraftReport } from "@sdr/shared";

// 8 µs preamble + 112 data bits, 2 samples/bit at 2 MSPS.
const PREAMBLE_SAMPLES = 16;
const LONG_BITS = 112;
const MSG_SAMPLES = PREAMBLE_SAMPLES + LONG_BITS * 2; // 240
// Scale float magnitudes (|iq| in ~0..√2) into dump1090's 0..65535 range so the
// ported absolute thresholds (the phase-correction delta) keep their meaning.
const MAG_SCALE = 46341;

// Mode S / ADS-B generator polynomial, x^24 + ... + 1 (0x1FFF409), as 25 bits.
const CRC_POLY = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1,
];

// 6-bit callsign character set (ICAO Annex 10).
const IDENT_CHARS =
  "#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####" + " ###############0123456789######";

interface CprFrame {
  lat: number; // raw 17-bit
  lon: number;
  t: number; // ms timestamp
}

interface Aircraft {
  icao: string;
  callsign?: string;
  altitude?: number;
  lat?: number;
  lon?: number;
  speed?: number;
  heading?: number;
  vertRate?: number;
  messages: number;
  lastSeen: number;
  cprEven?: CprFrame;
  cprOdd?: CprFrame;
}

const STALE_MS = 60_000; // drop aircraft not heard from in 60 s
const CPR_PAIR_MS = 10_000; // even/odd must be within 10 s to decode globally

export class AdsbReceiver {
  private aircraft = new Map<string, Aircraft>();
  private tail = new Float32Array(0);
  private bits = new Uint8Array(LONG_BITS);
  private msg = new Uint8Array(LONG_BITS / 8);
  private decoded = 0; // running count of valid frames, for rate display

  get totalMessages(): number {
    return this.decoded;
  }

  reset() {
    this.aircraft.clear();
    this.tail = new Float32Array(0);
  }

  /** `iq` is interleaved complex at 2 MSPS. */
  process(iq: Float32Array) {
    const nNew = iq.length >> 1;
    const mag = new Float32Array(this.tail.length + nNew);
    mag.set(this.tail, 0);
    let o = this.tail.length;
    for (let k = 0; k < nNew; k++) {
      const i = iq[2 * k]!;
      const q = iq[2 * k + 1]!;
      mag[o++] = Math.sqrt(i * i + q * q) * MAG_SCALE;
    }
    this.detect(mag);
    // Carry the trailing window so a frame straddling the chunk boundary is
    // recovered on the next call (magnitudes are per-sample, so this is exact).
    const carry = Math.min(mag.length, MSG_SAMPLES);
    this.tail = mag.slice(mag.length - carry);
  }

  /** Current aircraft table as plain reports, pruning stale entries. */
  snapshot(now: number): AircraftReport[] {
    const out: AircraftReport[] = [];
    for (const [icao, a] of this.aircraft) {
      if (now - a.lastSeen > STALE_MS) {
        this.aircraft.delete(icao);
        continue;
      }
      out.push({
        icao: a.icao,
        callsign: a.callsign,
        altitude: a.altitude,
        lat: a.lat,
        lon: a.lon,
        speed: a.speed,
        heading: a.heading,
        vertRate: a.vertRate,
        messages: a.messages,
        seen: (now - a.lastSeen) / 1000,
      });
    }
    return out;
  }

  // --- demodulation (dump1090 detectModeS, 2 MHz) ---

  private detect(m: Float32Array) {
    const len = m.length;
    const bits = this.bits;
    for (let j = 0; j + MSG_SAMPLES <= len; j++) {
      // Preamble: pulses at samples 0, 2, 7, 9; quiet in between.
      if (
        !(
          m[j]! > m[j + 1]! &&
          m[j + 1]! < m[j + 2]! &&
          m[j + 2]! > m[j + 3]! &&
          m[j + 3]! < m[j]! &&
          m[j + 4]! < m[j]! &&
          m[j + 5]! < m[j]! &&
          m[j + 6]! < m[j]! &&
          m[j + 7]! > m[j + 8]! &&
          m[j + 8]! < m[j + 9]! &&
          m[j + 9]! > m[j + 6]!
        )
      )
        continue;

      // The samples between the pulse pairs and just after must be low.
      const high = (m[j]! + m[j + 2]! + m[j + 7]! + m[j + 9]!) / 6;
      if (m[j + 4]! >= high || m[j + 5]! >= high) continue;
      if (
        m[j + 11]! >= high ||
        m[j + 12]! >= high ||
        m[j + 13]! >= high ||
        m[j + 14]! >= high
      )
        continue;

      // Manchester slice the 112 data bits (2 samples each).
      let errors = 0;
      let prev = 0;
      for (let i = 0; i < LONG_BITS * 2; i += 2) {
        const low = m[j + PREAMBLE_SAMPLES + i]!;
        const hi = m[j + PREAMBLE_SAMPLES + i + 1]!;
        let bit: number;
        if (low === hi) {
          // Ambiguous; carry the previous bit (dump1090 phase correction).
          bit = prev;
          errors++;
        } else {
          bit = low > hi ? 1 : 0;
        }
        bits[i >> 1] = bit;
        prev = bit;
      }
      if (errors > 6) continue;

      const msg = this.msg;
      for (let i = 0; i < LONG_BITS; i += 8) {
        msg[i >> 3] =
          (bits[i]! << 7) |
          (bits[i + 1]! << 6) |
          (bits[i + 2]! << 5) |
          (bits[i + 3]! << 4) |
          (bits[i + 4]! << 3) |
          (bits[i + 5]! << 2) |
          (bits[i + 6]! << 1) |
          bits[i + 7]!;
      }

      const df = msg[0]! >> 3;
      if (df !== 17 && df !== 18) continue; // only extended squitter
      if (crcResidual(msg) !== 0) continue; // reject on any bit error

      this.decoded++;
      this.handleMessage(msg);
      j += MSG_SAMPLES - 1; // skip past this frame
    }
  }

  // --- message decoding (DF17/DF18 ADS-B) ---

  private handleMessage(msg: Uint8Array) {
    const icao =
      msg[1]!.toString(16).padStart(2, "0") +
      msg[2]!.toString(16).padStart(2, "0") +
      msg[3]!.toString(16).padStart(2, "0");
    const tc = msg[4]! >> 3;
    const now = Date.now();

    let a = this.aircraft.get(icao);
    if (!a) {
      a = { icao, messages: 0, lastSeen: now };
      this.aircraft.set(icao, a);
    }
    a.messages++;
    a.lastSeen = now;

    if (tc >= 1 && tc <= 4) {
      a.callsign = decodeCallsign(msg);
    } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
      this.decodePosition(a, msg, tc, now);
    } else if (tc === 19) {
      decodeVelocity(a, msg);
    }
  }

  private decodePosition(
    a: Aircraft,
    msg: Uint8Array,
    tc: number,
    now: number,
  ) {
    if (tc >= 9 && tc <= 18) {
      const alt12 = (msg[5]! << 4) | (msg[6]! >> 4);
      const alt = decodeAltitude(alt12);
      if (alt != null) a.altitude = alt;
    }

    const odd = (msg[6]! & 0x04) !== 0;
    const latCpr = ((msg[6]! & 0x03) << 15) | (msg[7]! << 7) | (msg[8]! >> 1);
    const lonCpr = ((msg[8]! & 0x01) << 16) | (msg[9]! << 8) | msg[10]!;
    const frame: CprFrame = { lat: latCpr, lon: lonCpr, t: now };
    if (odd) a.cprOdd = frame;
    else a.cprEven = frame;

    if (
      a.cprEven &&
      a.cprOdd &&
      Math.abs(a.cprEven.t - a.cprOdd.t) <= CPR_PAIR_MS
    ) {
      const pos = cprGlobal(a.cprEven, a.cprOdd, odd);
      if (pos) {
        a.lat = pos.lat;
        a.lon = pos.lon;
      }
    }
  }
}

// --- helpers ---------------------------------------------------------------

/** 24-bit Mode S CRC residual over a 112-bit frame; 0 means a valid DF17/18. */
function crcResidual(msg: Uint8Array): number {
  const bits = new Uint8Array(LONG_BITS);
  for (let i = 0; i < LONG_BITS; i++) {
    bits[i] = (msg[i >> 3]! >> (7 - (i & 7))) & 1;
  }
  for (let i = 0; i < LONG_BITS - 24; i++) {
    if (bits[i]) {
      for (let j = 0; j < 25; j++) bits[i + j]! ^= CRC_POLY[j]!;
    }
  }
  let r = 0;
  for (let i = LONG_BITS - 24; i < LONG_BITS; i++) r = (r << 1) | bits[i]!;
  return r >>> 0;
}

function decodeCallsign(msg: Uint8Array): string {
  const b = [msg[5]!, msg[6]!, msg[7]!, msg[8]!, msg[9]!, msg[10]!];
  const idx = [
    b[0]! >> 2,
    ((b[0]! & 0x03) << 4) | (b[1]! >> 4),
    ((b[1]! & 0x0f) << 2) | (b[2]! >> 6),
    b[2]! & 0x3f,
    b[3]! >> 2,
    ((b[3]! & 0x03) << 4) | (b[4]! >> 4),
    ((b[4]! & 0x0f) << 2) | (b[5]! >> 6),
    b[5]! & 0x3f,
  ];
  let s = "";
  for (const i of idx) s += IDENT_CHARS[i] ?? "#";
  return s.replace(/#/g, "").trim();
}

/** 12-bit barometric altitude field -> feet (Q-bit / 25 ft increments). */
function decodeAltitude(alt12: number): number | null {
  if (alt12 === 0) return null;
  const qbit = alt12 & 0x10;
  if (!qbit) return null; // 100 ft Gillham coding, uncommon for ADS-B
  const n = ((alt12 & 0x0fe0) >> 1) | (alt12 & 0x000f);
  return n * 25 - 1000;
}

function decodeVelocity(a: Aircraft, msg: Uint8Array) {
  const subtype = msg[4]! & 0x07;
  if (subtype !== 1 && subtype !== 2) return; // ground-speed subtypes only
  const sEw = (msg[5]! & 0x04) >> 2;
  const vEw = ((msg[5]! & 0x03) << 8) | msg[6]!;
  const sNs = (msg[7]! & 0x80) >> 7;
  const vNs = ((msg[7]! & 0x7f) << 3) | (msg[8]! >> 5);
  if (vEw === 0 || vNs === 0) return; // no velocity available
  const mult = subtype === 2 ? 4 : 1;
  const vx = (sEw ? -1 : 1) * (vEw - 1) * mult;
  const vy = (sNs ? -1 : 1) * (vNs - 1) * mult;
  a.speed = Math.round(Math.hypot(vx, vy));
  let hdg = (Math.atan2(vx, vy) * 180) / Math.PI;
  if (hdg < 0) hdg += 360;
  a.heading = Math.round(hdg);

  const sVr = (msg[8]! & 0x08) >> 3;
  const vr = ((msg[8]! & 0x07) << 6) | (msg[9]! >> 2);
  if (vr !== 0) a.vertRate = (sVr ? -1 : 1) * (vr - 1) * 64;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Longitude-zone count for a given latitude (CPR NL function). */
function cprNL(lat: number): number {
  if (lat === 0) return 59;
  if (Math.abs(lat) === 87) return 2;
  if (lat > 87 || lat < -87) return 1;
  const nz = 15;
  const a = 1 - Math.cos(Math.PI / (2 * nz));
  const b = Math.cos((Math.PI / 180) * Math.abs(lat)) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - a / b));
}

/** Globally unambiguous position from an even+odd CPR pair. */
function cprGlobal(
  even: CprFrame,
  odd: CprFrame,
  lastIsOdd: boolean,
): { lat: number; lon: number } | null {
  const latEvenCpr = even.lat / 131072;
  const lonEvenCpr = even.lon / 131072;
  const latOddCpr = odd.lat / 131072;
  const lonOddCpr = odd.lon / 131072;

  const j = Math.floor(59 * latEvenCpr - 60 * latOddCpr + 0.5);
  let rlatEven = (360 / 60) * (mod(j, 60) + latEvenCpr);
  let rlatOdd = (360 / 59) * (mod(j, 59) + latOddCpr);
  if (rlatEven >= 270) rlatEven -= 360;
  if (rlatOdd >= 270) rlatOdd -= 360;
  if (cprNL(rlatEven) !== cprNL(rlatOdd)) return null;

  let lat: number;
  let lon: number;
  if (!lastIsOdd) {
    const nl = cprNL(rlatEven);
    const ni = Math.max(nl, 1);
    const m = Math.floor(lonEvenCpr * (nl - 1) - lonOddCpr * nl + 0.5);
    lon = (360 / ni) * (mod(m, ni) + lonEvenCpr);
    lat = rlatEven;
  } else {
    const nl = cprNL(rlatOdd);
    const ni = Math.max(nl - 1, 1);
    const m = Math.floor(lonEvenCpr * (nl - 1) - lonOddCpr * nl + 0.5);
    lon = (360 / ni) * (mod(m, ni) + lonOddCpr);
    lat = rlatOdd;
  }
  if (lon >= 180) lon -= 360;
  if (lat < -90 || lat > 90) return null;
  return { lat, lon };
}
