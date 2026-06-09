// RDS / RBDS decoder for broadcast FM. Consumes the FM multiplex (MPX) signal —
// the discriminator output *before* de-emphasis, which still carries the 57 kHz
// RDS subcarrier — and recovers the data link the slow way rtl_fm/redsea do:
//
//   MPX (real, @ channelRate)
//     -> downconvert by 57 kHz (complex) + decimating low-pass  (-> ~16 kHz)
//     -> Costas loop          (BPSK carrier/phase recovery -> real baseband)
//     -> biphase matched filter (correlate against the Manchester symbol)
//     -> Mueller–Müller timing  (one symbol decision per 1187.5 Hz period)
//     -> differential decode    (kills the BPSK 180° ambiguity)
//     -> block synchroniser     ((26,16) cyclic code, syndrome == offset word)
//     -> group parser           (0A/0B PS, 2A/2B RadioText, 4A clock-time)
//
// The decoder is fed continuously while the receiver is in WFM mode and is reset
// on every retune. It is deliberately self-contained: the only shared DSP it
// borrows is the FIR design + the streaming complex decimator.

import { designLowpass, tapsFor, ComplexDecimator, RealFir } from "./filters";
import type { RdsStation, RdsStats, RdsClockTime } from "@sdr/shared";

const SUBCARRIER_HZ = 57_000;
const BIT_RATE = 1_187.5; // RDS data rate (= 57000 / 48), bits per second
const DEC_TARGET_HZ = 16_000; // rate we run the bit-sync chain at

// (26,16) cyclic block code. g(x) = x^10+x^8+x^7+x^5+x^4+x^3+1 = 0x5B9.
// Because every offset word has degree < 10, the remainder of a valid block
// (codeword XOR offset) modulo g is simply the offset word itself — so the
// syndrome of a good block equals its offset value directly.
const POLY = 0x5b9;
const OFFSET = { A: 0x0fc, B: 0x198, C: 0x168, Cp: 0x350, D: 0x1b4 } as const;
/** Block index (0..3 within a group) implied by a detected offset syndrome. */
const BLOCK_NUM_BY_OFFSET: Record<number, number> = {
  [OFFSET.A]: 0,
  [OFFSET.B]: 1,
  [OFFSET.C]: 2,
  [OFFSET.Cp]: 2,
  [OFFSET.D]: 3,
};

/** RBDS (North America) programme-type names, indexed by PTY code 0–31. */
const PTY_RBDS = [
  "None", "News", "Information", "Sports", "Talk", "Rock", "Classic Rock",
  "Adult Hits", "Soft Rock", "Top 40", "Country", "Oldies", "Soft", "Nostalgia",
  "Jazz", "Classical", "Rhythm and Blues", "Soft R&B", "Foreign Language",
  "Religious Music", "Religious Talk", "Personality", "Public", "College",
  "Spanish Talk", "Spanish Music", "Hip Hop", "Unassigned", "Unassigned",
  "Weather", "Emergency Test", "Emergency",
];

/** Remainder of a ≤26-bit polynomial modulo g(x) — the block syndrome. */
function syndrome(block: number): number {
  let reg = block;
  for (let i = 25; i >= 10; i--) {
    if ((reg >> i) & 1) reg ^= POLY << (i - 10);
  }
  return reg & 0x3ff;
}

/** RBDS PI → call sign (4-letter K/W algorithm); undefined when not decodable. */
function piToCallSign(pi: number): string | undefined {
  if (pi < 0x1000 || pi > 0x994f) return undefined;
  let prefix: string;
  let val: number;
  if (pi >= 0x54a8) {
    prefix = "W";
    val = pi - 0x54a8;
  } else {
    prefix = "K";
    val = pi - 0x1000;
  }
  const c1 = Math.floor(val / 676);
  const c2 = Math.floor((val % 676) / 26);
  const c3 = val % 26;
  if (c1 > 25) return undefined;
  return prefix + String.fromCharCode(65 + c1, 65 + c2, 65 + c3);
}

/** Map an RDS character byte to printable ASCII, others to a space. */
function rdsChar(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : " ";
}

/** Convert a Modified Julian Date + UTC time + local offset to a clock-time. */
function decodeClock(
  mjd: number,
  hour: number,
  minute: number,
  offsetHalfHours: number,
  offsetNeg: boolean,
): RdsClockTime | null {
  if (hour > 23 || minute > 59) return null;
  const yp = Math.floor((mjd - 15078.2) / 365.25);
  const mp = Math.floor((mjd - 14956.1 - Math.floor(yp * 365.25)) / 30.6001);
  const day = mjd - 14956 - Math.floor(yp * 365.25) - Math.floor(mp * 30.6001);
  const k = mp === 14 || mp === 15 ? 1 : 0;
  const year = 1900 + yp + k;
  const month = mp - 1 - k * 12;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2099)
    return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const offMin = offsetHalfHours * 30 * (offsetNeg ? -1 : 1);
  const local = new Date(utc + offMin * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const sign = offsetNeg ? "-" : "+";
  const oh = Math.floor(Math.abs(offMin) / 60);
  const om = Math.abs(offMin) % 60;
  const iso =
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}${sign}${p(oh)}:${p(om)}`;
  return { iso, epoch: utc };
}

export class RdsDecoder {
  // --- front-end (downconvert + decimate) ---
  private fs = 256_000;
  private mixStepCos = 1;
  private mixStepSin = 0;
  private mixCos = 1;
  private mixSin = 0;
  private mixN = 0;
  private decim!: ComplexDecimator;

  // --- Costas (carrier/phase) loop ---
  private phi = 0;
  private freq = 0;
  private readonly cAlpha = 0.013; // phase gain
  private readonly cBeta = 9e-5; // frequency gain
  private agc = 1; // running magnitude estimate, drives input normalisation

  // --- biphase matched filter + symbol timing ---
  private matched!: RealFir;
  private sps = 13.47; // samples per symbol at the decimated rate
  private mmOmega = 13.47; // tracked samples/symbol
  private mmAcc = 0;
  private mmPrevY = 0;
  private mmPrevDec = 1;
  private lastDiffBit = 0;

  // --- block synchroniser ---
  private reg = 0;
  private locked = false;
  private blockIndex = 0;
  private bitCount = 0;
  private consecBad = 0;
  // Hunt state: the last offset word seen and how many bits ago, so we only
  // lock when two valid offsets arrive 26 bits apart in the right sequence.
  private huntPrevOff = -1;
  private huntSince = 0;
  private blocks = [0, 0, 0, 0];
  private blockValid = [false, false, false, false];
  private ber = 1; // exponential-average block error rate, 0..1
  private groups = 0;

  // --- assembled station state ---
  private pi = 0;
  private havePi = false;
  private piCandidate = -1; // PI must repeat across two groups before we trust it
  private psConf = new Array<number>(8).fill(0);
  private psTent = new Array<number>(8).fill(0);
  private rtConf = new Array<number>(64).fill(0);
  private rtTent = new Array<number>(64).fill(0);
  private rtAb = -1;
  private rtLen = 0;
  private station: RdsStation | null = null;
  private pty?: number;
  private tp?: boolean;
  private ta?: boolean;
  private music?: boolean;
  private stereo?: boolean;
  private clock?: RdsClockTime;
  private afSet = new Set<number>();

  // --- diagnostics (read + reset by diag(); env-gated logging in the session) ---
  private dMpxAbs = 0;
  private dMpxN = 0;
  private dSubAbs = 0;
  private dSubN = 0;
  private dMatches = 0;

  constructor(fs = 256_000) {
    this.configure(fs);
  }

  /** (Re)configure for a channel sample rate and clear all decoder state. */
  configure(fs: number) {
    this.fs = fs;
    const w = (2 * Math.PI * SUBCARRIER_HZ) / fs;
    this.mixStepCos = Math.cos(w);
    this.mixStepSin = Math.sin(w);

    const decim = Math.max(1, Math.round(fs / DEC_TARGET_HZ));
    const fsDec = fs / decim;
    // Anti-alias low-pass: pass the RDS main lobe (~±2.4 kHz), reject the L−R
    // stereo subcarrier tail and everything that would fold past fsDec/2.
    const cutoff = 2_400 / fs;
    const taps = tapsFor(0.014);
    this.decim = new ComplexDecimator(designLowpass(taps, cutoff), decim);

    this.sps = fsDec / BIT_RATE;
    this.mmOmega = this.sps;
    // Matched filter: the bi-phase (Manchester) symbol — first half +1, second
    // half −1 — normalised so its peak output is ~unit amplitude.
    const half = this.sps / 2;
    const len = Math.max(2, Math.round(this.sps));
    const tmpl = new Float32Array(len);
    for (let k = 0; k < len; k++) tmpl[k] = k < half ? 1 / half : -1 / half;
    this.matched = new RealFir(tmpl);

    this.reset();
  }

  /** Clear all decoded data and re-acquire from scratch (called on retune). */
  reset() {
    this.mixCos = 1;
    this.mixSin = 0;
    this.mixN = 0;
    this.phi = 0;
    this.freq = 0;
    this.agc = 1;
    this.mmAcc = 0;
    this.mmOmega = this.sps;
    this.mmPrevY = 0;
    this.mmPrevDec = 1;
    this.lastDiffBit = 0;
    this.reg = 0;
    this.locked = false;
    this.blockIndex = 0;
    this.bitCount = 0;
    this.consecBad = 0;
    this.huntPrevOff = -1;
    this.huntSince = 0;
    this.blockValid = [false, false, false, false];
    this.ber = 1;
    this.groups = 0;
    this.havePi = false;
    this.pi = 0;
    this.piCandidate = -1;
    this.psConf.fill(0);
    this.psTent.fill(0);
    this.rtConf.fill(0);
    this.rtTent.fill(0);
    this.rtAb = -1;
    this.rtLen = 0;
    this.pty = undefined;
    this.tp = undefined;
    this.ta = undefined;
    this.music = undefined;
    this.stereo = undefined;
    this.clock = undefined;
    this.afSet.clear();
    this.station = null;
  }

  /** Feed `n` real MPX samples (the FM discriminator output before de-emphasis). */
  process(mpx: Float32Array, n: number) {
    // 1. Downconvert by 57 kHz into an interleaved complex buffer.
    const cplx = new Float32Array(2 * n);
    let c = this.mixCos;
    let s = this.mixSin;
    const sc = this.mixStepCos;
    const ss = this.mixStepSin;
    for (let k = 0; k < n; k++) {
      const x = mpx[k]!;
      cplx[2 * k] = x * c; // I = x·cos(wt)
      cplx[2 * k + 1] = -x * s; // Q = −x·sin(wt)  (shift down by e^{−jwt})
      const nc = c * sc - s * ss;
      const nsv = c * ss + s * sc;
      c = nc;
      s = nsv;
      if ((this.mixN++ & 0x3ff) === 0) {
        const mag = Math.hypot(c, s) || 1;
        c /= mag;
        s /= mag;
      }
    }
    this.mixCos = c;
    this.mixSin = s;

    // 2. Decimating low-pass → narrowband complex baseband at ~16 kHz.
    const dec = this.decim.process(cplx);
    const m = dec.length / 2;
    if (m === 0) return;

    // Diagnostics: overall MPX level vs energy in the ±2.4 kHz RDS band.
    for (let k = 0; k < n; k++) this.dMpxAbs += Math.abs(mpx[k]!);
    this.dMpxN += n;
    for (let j = 0; j < m; j++) this.dSubAbs += Math.hypot(dec[2 * j]!, dec[2 * j + 1]!);
    this.dSubN += m;

    // 3. Costas loop: derotate to a real BPSK baseband.
    const baseband = new Float32Array(m);
    let phi = this.phi;
    let freq = this.freq;
    for (let j = 0; j < m; j++) {
      let I = dec[2 * j]!;
      let Q = dec[2 * j + 1]!;
      // Normalise amplitude so the loop gains are well-defined.
      const mag = Math.hypot(I, Q);
      this.agc += 0.002 * (mag - this.agc);
      const g = this.agc > 1e-6 ? 1 / this.agc : 1;
      I *= g;
      Q *= g;
      const ci = Math.cos(phi);
      const si = Math.sin(phi);
      const di = I * ci + Q * si;
      const dq = Q * ci - I * si;
      baseband[j] = di;
      const e = (di >= 0 ? 1 : -1) * dq; // decision-directed BPSK error
      freq += this.cBeta * e;
      phi += freq + this.cAlpha * e;
      if (phi > Math.PI) phi -= 2 * Math.PI;
      else if (phi < -Math.PI) phi += 2 * Math.PI;
    }
    this.phi = phi;
    this.freq = freq;

    // 4. Biphase matched filter.
    const mf = this.matched.process(baseband);

    // 5. Mueller–Müller symbol timing: one decision per ~sps samples.
    let acc = this.mmAcc;
    for (let j = 0; j < mf.length; j++) {
      acc += 1;
      if (acc >= this.mmOmega) {
        acc -= this.mmOmega;
        const y = mf[j]!;
        const dec2 = y >= 0 ? 1 : -1;
        // Mueller–Müller timing error; nudge the strobe phase and (slowly) the
        // period so the loop tracks small sample-clock offsets without slipping.
        const e = dec2 * this.mmPrevY - this.mmPrevDec * y;
        this.mmOmega += 2e-4 * e;
        if (this.mmOmega < this.sps * 0.98) this.mmOmega = this.sps * 0.98;
        else if (this.mmOmega > this.sps * 1.02) this.mmOmega = this.sps * 1.02;
        acc -= 0.02 * e;
        this.mmPrevY = y;
        this.mmPrevDec = dec2;
        // 6. Differential decode (resolves the carrier 180° ambiguity).
        const diffBit = dec2 > 0 ? 1 : 0;
        const msgBit = diffBit ^ this.lastDiffBit;
        this.lastDiffBit = diffBit;
        this.pushBit(msgBit);
      }
    }
    this.mmAcc = acc;
  }

  // --- block synchroniser -------------------------------------------------

  private pushBit(bit: number) {
    this.reg = ((this.reg << 1) | bit) & 0x3ffffff; // 26-bit window
    if (!this.locked) {
      // Hunting. A single 26-bit window matches an offset word by chance roughly
      // 1-in-200 on noise, so we never lock on one match. We require a second
      // valid offset exactly 26 bits later and one block further in the A→B→C→D
      // sequence — a coincidence vanishingly unlikely on noise.
      this.huntSince++;
      const num = BLOCK_NUM_BY_OFFSET[syndrome(this.reg)];
      if (num !== undefined) {
        this.dMatches++;
        if (
          this.huntPrevOff >= 0 &&
          this.huntSince === 26 &&
          num === (this.huntPrevOff + 1) % 4
        ) {
          this.locked = true;
          this.blockIndex = num;
          this.bitCount = 0;
          this.consecBad = 0;
          this.blockValid = [false, false, false, false];
          this.storeBlock(num, this.reg, true);
        } else {
          this.huntPrevOff = num;
        }
        this.huntSince = 0;
      } else if (this.huntSince > 27) {
        this.huntPrevOff = -1; // candidate went stale
      }
      return;
    }
    if (++this.bitCount < 26) return;
    this.bitCount = 0;
    this.blockIndex = (this.blockIndex + 1) % 4;
    const syn = syndrome(this.reg);
    const ok = this.matchesExpected(this.blockIndex, syn);
    this.storeBlock(this.blockIndex, this.reg, ok);
    this.ber += 0.05 * ((ok ? 0 : 1) - this.ber);
    this.consecBad = ok ? 0 : this.consecBad + 1;
    if (this.blockIndex === 3) this.parseGroup();
    if (this.consecBad >= 8) this.loseLock(); // genuine drop, re-acquire cleanly
  }

  private loseLock() {
    this.locked = false;
    this.huntPrevOff = -1;
    this.huntSince = 0;
    this.blockValid = [false, false, false, false];
  }

  private matchesExpected(idx: number, syn: number): boolean {
    if (idx === 0) return syn === OFFSET.A;
    if (idx === 1) return syn === OFFSET.B;
    if (idx === 2) return syn === OFFSET.C || syn === OFFSET.Cp;
    return syn === OFFSET.D;
  }

  private storeBlock(idx: number, reg: number, valid: boolean) {
    this.blocks[idx] = (reg >> 10) & 0xffff;
    this.blockValid[idx] = valid;
  }

  // --- group parser -------------------------------------------------------

  private parseGroup() {
    const [a, b, c, d] = this.blocks;
    const [va, vb, vc, vd] = this.blockValid;
    if (va) this.setPi(a!);
    if (!vb) return; // need block B to interpret anything
    this.groups++;

    const groupType = (b! >> 12) & 0xf;
    const versionB = (b! >> 11) & 1;
    this.tp = ((b! >> 10) & 1) === 1;
    this.pty = (b! >> 5) & 0x1f;
    if (versionB && vc) this.setPi(c!); // version-B groups repeat PI in block C

    if (groupType === 0) {
      this.ta = ((b! >> 4) & 1) === 1;
      this.music = ((b! >> 3) & 1) === 1;
      const diBit = (b! >> 2) & 1;
      const seg = b! & 0x3;
      if (seg === 0) this.stereo = diBit === 1;
      if (vd) {
        this.setPsChar(seg * 2, (d! >> 8) & 0xff);
        this.setPsChar(seg * 2 + 1, d! & 0xff);
      }
      if (versionB === 0 && vc) this.parseAf(c!);
    } else if (groupType === 2) {
      const ab = (b! >> 4) & 1;
      if (ab !== this.rtAb) {
        this.rtConf.fill(0);
        this.rtTent.fill(0);
        this.rtLen = 0;
        this.rtAb = ab;
      }
      const seg = b! & 0xf;
      if (versionB === 0) {
        if (vc) {
          this.setRtChar(seg * 4, (c! >> 8) & 0xff);
          this.setRtChar(seg * 4 + 1, c! & 0xff);
        }
        if (vd) {
          this.setRtChar(seg * 4 + 2, (d! >> 8) & 0xff);
          this.setRtChar(seg * 4 + 3, d! & 0xff);
        }
      } else if (vd) {
        this.setRtChar(seg * 2, (d! >> 8) & 0xff);
        this.setRtChar(seg * 2 + 1, d! & 0xff);
      }
    } else if (groupType === 4 && versionB === 0 && vc && vd) {
      const mjd = ((b! & 0x3) << 15) | ((c! >> 1) & 0x7fff);
      const hour = ((c! & 0x1) << 4) | ((d! >> 12) & 0xf);
      const minute = (d! >> 6) & 0x3f;
      const offNeg = ((d! >> 5) & 1) === 1;
      const off = d! & 0x1f;
      const ct = decodeClock(mjd, hour, minute, off, offNeg);
      if (ct) this.clock = ct;
    }
    this.rebuildStation();
  }

  // The PI is the station's identity, so it must repeat across two groups before
  // we trust it — a single CRC-valid-by-chance block can't conjure a station.
  private setPi(pi: number) {
    if (pi === this.piCandidate) {
      this.pi = pi;
      this.havePi = true;
    }
    this.piCandidate = pi;
  }

  // PS/RT use a per-character double-buffer: a glyph is only shown once two
  // groups agree on it, which suppresses transient garbage from weak blocks.
  private setPsChar(i: number, byte: number) {
    if (i < 0 || i > 7) return;
    if (byte === this.psTent[i]) this.psConf[i] = byte;
    this.psTent[i] = byte;
  }
  private setRtChar(i: number, byte: number) {
    if (i < 0 || i > 63) return;
    if (byte === this.rtTent[i]) {
      this.rtConf[i] = byte;
      if (byte === 0x0d && (this.rtLen === 0 || i + 1 < this.rtLen)) this.rtLen = i;
      else if (byte !== 0x0d && i + 1 > this.rtLen) this.rtLen = i + 1;
    }
    this.rtTent[i] = byte;
  }

  private parseAf(block: number) {
    for (const code of [(block >> 8) & 0xff, block & 0xff]) {
      if (code >= 1 && code <= 204) {
        const mhz = 87.5 + code * 0.1;
        if (this.afSet.size < 25) this.afSet.add(Math.round(mhz * 10) / 10);
      }
    }
  }

  private rebuildStation() {
    if (!this.havePi) return;
    const ps = this.confirmedString(this.psConf, 8).trimEnd();
    const rt = this.confirmedString(this.rtConf, this.rtLen || 0).trimEnd();
    const st: RdsStation = { pi: this.pi.toString(16).toUpperCase().padStart(4, "0") };
    const call = piToCallSign(this.pi);
    if (call) st.callSign = call;
    if (ps) st.ps = ps;
    if (rt) st.radioText = rt;
    if (this.pty !== undefined) {
      st.pty = this.pty;
      st.ptyName = PTY_RBDS[this.pty];
    }
    if (this.tp !== undefined) st.tp = this.tp;
    if (this.ta !== undefined) st.ta = this.ta;
    if (this.music !== undefined) st.music = this.music;
    if (this.stereo !== undefined) st.stereo = this.stereo;
    if (this.afSet.size) st.altFreqs = [...this.afSet].sort((x, y) => x - y);
    if (this.clock) st.clock = this.clock;
    this.station = st;
  }

  private confirmedString(buf: number[], len: number): string {
    let out = "";
    for (let i = 0; i < len; i++) out += buf[i] ? rdsChar(buf[i]!) : " ";
    return out;
  }

  // --- output -------------------------------------------------------------

  snapshot(): RdsStation | null {
    return this.station;
  }

  stats(): RdsStats {
    // "Synced" means a genuine, low-error lock — not merely "haven't given up
    // hunting yet" — so the panel never shows lock alongside a 100% error rate.
    return {
      groups: this.groups,
      blockErrorRate: this.ber,
      synced: this.locked && this.ber < 0.5,
    };
  }

  /**
   * One-line health readout for debugging reception, sampled+reset per call.
   * `sub/mpx` is the fraction of signal energy sitting in the ±2.4 kHz band
   * around 57 kHz (a present RDS subcarrier shows up here); `matches` is offset
   * words seen while hunting (≈0 means no recoverable bit structure).
   */
  diag(): string {
    const mpx = this.dMpxN ? this.dMpxAbs / this.dMpxN : 0;
    const sub = this.dSubN ? this.dSubAbs / this.dSubN : 0;
    const ratio = mpx > 0 ? (sub / mpx) * 100 : 0;
    const line =
      `sub/mpx=${ratio.toFixed(1)}% matches=${this.dMatches} ` +
      `locked=${this.locked} ber=${(this.ber * 100).toFixed(0)}% ` +
      `groups=${this.groups} omega=${this.mmOmega.toFixed(2)}/${this.sps.toFixed(2)}`;
    this.dMpxAbs = this.dMpxN = this.dSubAbs = this.dSubN = this.dMatches = 0;
    return line;
  }
}
