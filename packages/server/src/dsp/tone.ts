// Sub-audible tone decoder (CTCSS + DCS) for NFM tone squelch. Fed the raw FM
// discriminator output at the channel rate, where CTCSS appears as a sine
// below 260 Hz and DCS as a 134.4 bps NRZ bitstream — both under the voice.
//
//   disc ──► LPF 300 Hz + decimate (~6 kHz) ──┬─► Goertzel bank (50 CTCSS tones)
//                                             └─► bit slicer ─► 23-bit Golay words
//
// CTCSS: incremental Goertzel over ~0.4 s windows (long enough to split the
// 2.4 Hz-spaced tones at the top of the table); a tone is reported only when
// it clearly dominates the band. DCS: adaptive mid-level slicer with edge
// resync (structure after SDRangel's DCSDetector), validating every 23-bit
// window via signature + Golay parity, in both polarities; a code must repeat
// before it is reported. Detected raw codes are mapped to canonical standard
// codes (a repeated codeword also validates at rotated alignments that read
// as different codes — see shared/tones.ts).

import {
  type ToneSquelch,
  CTCSS_TONES,
  DCS_BAUD,
  dcsCanonical,
  dcsCheckWord,
} from "@sdr/shared";
import { RealFir, designLowpass, tapsFor } from "./filters";

const LF_TARGET_RATE = 6_000; // decimated rate the detectors run at
const LF_CUTOFF_HZ = 300; // passes CTCSS (≤254 Hz) and DCS, rejects voice
const CTCSS_WINDOW_S = 0.4; // Goertzel window; ~2.5 Hz resolution
const CTCSS_MIN_AMP = 0.02; // tone amplitude floor, in deviation units
const CTCSS_PEAK_RATIO = 4; // best tone ≥ 4× the runner-up
const CTCSS_MEAN_RATIO = 8; // best tone ≥ 8× the mean of the others
const DCS_CONFIRM_MS = 700; // a code must repeat within this to confirm
const DCS_FRESH_MS = 900; // confirmed code expires after this without re-decode

interface DcsBranch {
  // Sliding 23-bit window; bit 0 is the oldest (first-transmitted) bit.
  candidate: number;
  candidateAtMs: number;
  code: number | null;
  freshUntilMs: number;
}

const emptyBranch = (): DcsBranch => ({
  candidate: -1,
  candidateAtMs: 0,
  code: null,
  freshUntilMs: 0,
});

export class ToneDecoder {
  private lp!: RealFir;
  private decim = 1;
  private decimPhase = 0;
  private lfRate = LF_TARGET_RATE;
  private timeMs = 0;

  // CTCSS incremental Goertzel state (one s1/s2 pair per tone).
  private coeffs!: Float64Array;
  private s1!: Float64Array;
  private s2!: Float64Array;
  private windowLen = 0;
  private windowPos = 0;
  private ctcssHz: number | null = null;
  private ctcssUntilMs = 0;

  // DCS slicer state.
  private bitsPerSample = 0;
  private eqLen = 0;
  private eqBuf!: Float32Array;
  private eqPos = 0;
  private mid = 0;
  private prevSample = 0;
  private bitPhase = 0;
  private word = 0;
  private normal = emptyBranch();
  private inverted = emptyBranch();

  constructor(channelRate = 64_000) {
    this.configure(channelRate);
  }

  configure(channelRate: number) {
    this.decim = Math.max(1, Math.round(channelRate / LF_TARGET_RATE));
    this.lfRate = channelRate / this.decim;
    const trans = Math.max((this.lfRate / 2 - LF_CUTOFF_HZ) / channelRate, 0.002);
    this.lp = new RealFir(designLowpass(tapsFor(trans), LF_CUTOFF_HZ / channelRate));

    this.coeffs = new Float64Array(CTCSS_TONES.length);
    for (let i = 0; i < CTCSS_TONES.length; i++) {
      this.coeffs[i] = 2 * Math.cos((2 * Math.PI * CTCSS_TONES[i]!) / this.lfRate);
    }
    this.s1 = new Float64Array(CTCSS_TONES.length);
    this.s2 = new Float64Array(CTCSS_TONES.length);
    this.windowLen = Math.round(CTCSS_WINDOW_S * this.lfRate);

    this.bitsPerSample = DCS_BAUD / this.lfRate;
    this.eqLen = Math.round((23 / DCS_BAUD) * this.lfRate); // one word of samples
    this.eqBuf = new Float32Array(this.eqLen);
    this.reset();
  }

  /** Drop all detection state (call on retune — the channel changed). */
  reset() {
    this.decimPhase = 0;
    this.s1.fill(0);
    this.s2.fill(0);
    this.windowPos = 0;
    this.ctcssHz = null;
    this.ctcssUntilMs = 0;
    this.eqPos = 0;
    this.mid = 0;
    this.prevSample = 0;
    this.bitPhase = 0;
    this.word = 0;
    this.normal = emptyBranch();
    this.inverted = emptyBranch();
  }

  /** Feed a block of FM discriminator output at the configured channel rate. */
  process(disc: Float32Array, n: number) {
    this.timeMs += (n / (this.lfRate * this.decim)) * 1000;
    const filtered = this.lp.process(disc.subarray(0, n));
    for (let k = this.decimPhase; k < n; k += this.decim) {
      this.feedLf(filtered[k]!);
    }
    this.decimPhase = (this.decimPhase - (n % this.decim) + this.decim) % this.decim;
  }

  /** The tone to display for this channel, or null. DCS outranks CTCSS (a DCS
   *  waveform can also tickle a CTCSS bin; the reverse can't happen). */
  detected(): ToneSquelch | null {
    const now = this.timeMs;
    if (this.normal.code != null && now < this.normal.freshUntilMs) {
      return { kind: "dcs", code: this.normal.code, inverted: false };
    }
    if (this.inverted.code != null && now < this.inverted.freshUntilMs) {
      return { kind: "dcs", code: this.inverted.code, inverted: true };
    }
    if (this.ctcssHz != null && now < this.ctcssUntilMs) {
      return { kind: "ctcss", hz: this.ctcssHz };
    }
    return null;
  }

  /** Whether the required tone is currently present on the channel. Both DCS
   *  polarities are tracked, so an inverted selection matches directly. */
  matches(want: ToneSquelch): boolean {
    const now = this.timeMs;
    if (want.kind === "ctcss") {
      return (
        this.ctcssHz != null &&
        now < this.ctcssUntilMs &&
        Math.abs(this.ctcssHz - want.hz) < 0.05
      );
    }
    const branch = want.inverted ? this.inverted : this.normal;
    return branch.code === want.code && now < branch.freshUntilMs;
  }

  // --- per-LF-sample work ---------------------------------------------------

  private feedLf(s: number) {
    // CTCSS: advance every Goertzel accumulator; evaluate at window end.
    const c = this.coeffs;
    const s1 = this.s1;
    const s2 = this.s2;
    for (let i = 0; i < c.length; i++) {
      const t = s + c[i]! * s1[i]! - s2[i]!;
      s2[i] = s1[i]!;
      s1[i] = t;
    }
    if (++this.windowPos >= this.windowLen) this.evaluateCtcssWindow();

    // DCS: track the slicer mid-level over one word of samples.
    this.eqBuf[this.eqPos++] = s;
    if (this.eqPos === this.eqLen) {
      let high = -Infinity;
      let low = Infinity;
      for (const v of this.eqBuf) {
        if (v > high) high = v;
        if (v < low) low = v;
      }
      this.mid = (high + low) / 2;
      this.eqPos = 0;
    }

    // Resync the bit clock on every mid-level crossing.
    const mid = this.mid;
    if (
      (this.prevSample < mid && s >= mid) ||
      (this.prevSample > mid && s <= mid)
    ) {
      this.bitPhase = 0;
    }
    this.prevSample = s;
    const prevPhase = this.bitPhase;
    this.bitPhase += this.bitsPerSample;
    if (prevPhase < 0.5 && this.bitPhase >= 0.5) {
      // Bit centre: shift in the new bit (oldest bit ends up at bit 0, matching
      // the LSB-first on-air order that dcsCheckWord expects).
      this.word = ((this.word >> 1) | ((s > mid ? 1 : 0) << 22)) & 0x7fffff;
      this.checkDcsWord(this.word, this.normal);
      this.checkDcsWord(~this.word & 0x7fffff, this.inverted);
    }
    if (this.bitPhase > 1) this.bitPhase -= 1;
  }

  private checkDcsWord(word: number, branch: DcsBranch) {
    const raw = dcsCheckWord(word);
    if (raw == null) return;
    const code = dcsCanonical(raw);
    if (code == null) return;
    const now = this.timeMs;
    if (branch.candidate === code && now - branch.candidateAtMs <= DCS_CONFIRM_MS) {
      branch.code = code;
      branch.freshUntilMs = now + DCS_FRESH_MS;
    }
    branch.candidate = code;
    branch.candidateAtMs = now;
  }

  private evaluateCtcssWindow() {
    const n = this.windowLen;
    let best = -1;
    let bestPower = 0;
    let second = 0;
    let sum = 0;
    for (let i = 0; i < this.coeffs.length; i++) {
      const a = this.s1[i]!;
      const b = this.s2[i]!;
      const p = a * a + b * b - this.coeffs[i]! * a * b;
      sum += p;
      if (p > bestPower) {
        second = bestPower;
        bestPower = p;
        best = i;
      } else if (p > second) {
        second = p;
      }
    }
    this.s1.fill(0);
    this.s2.fill(0);
    this.windowPos = 0;

    // |X|² for a full-scale sine is (A·N/2)², so A² = 4·power/N².
    const amp = Math.sqrt((4 * bestPower) / (n * n));
    const meanOthers = (sum - bestPower) / (this.coeffs.length - 1);
    const dominant =
      best >= 0 &&
      amp >= CTCSS_MIN_AMP &&
      bestPower >= CTCSS_PEAK_RATIO * second &&
      bestPower >= CTCSS_MEAN_RATIO * meanOthers;
    if (dominant) {
      this.ctcssHz = CTCSS_TONES[best]!;
      this.ctcssUntilMs = this.timeMs + 1.5 * CTCSS_WINDOW_S * 1000;
    } else {
      this.ctcssHz = null;
    }
  }
}
