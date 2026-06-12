// Per-mode demodulator. Input is interleaved complex IQ at the dongle sample
// rate, already frequency-shifted so the signal of interest sits at DC (the
// session's VFO NCO does that). Output is mono audio at AUDIO_RATE plus the
// in-channel power in dB (for squelch / S-meter).
//
// Pipeline per block:
//   ComplexDecimator (fs -> channelRate)
//     -> [noise blanker]  (impulse removal, complex)
//     -> [notch cascade]  (kill carriers/hets, complex)
//     -> mode demod        (FM / AM / SSB-CW via a generalised Weaver stage)
//     -> audio low-pass
//     -> [noise reduction] (LMS, audio)
//     -> [audio AGC]
//     -> LinearResampler (-> AUDIO_RATE)
//
// The channel filter is described by two edges (low, high) in Hz relative to the
// VFO, so the passband can be tuned/shifted asymmetrically. AM/SSB/CW share one
// "shift to passband centre, low-pass the half-width, shift back" core.

import type { AgcMode, Mode, ToneSquelch } from "@sdr/shared";
import { AUDIO_RATE } from "@sdr/shared";
import {
  ComplexDecimator,
  ComplexNotch,
  RealFir,
  designLowpass,
  tapsFor,
} from "./filters";
import { LinearResampler } from "./resample";
import { Nco } from "./nco";
import { AudioAgc, LmsDenoiser, NoiseBlanker } from "./enhance";
import { RdsDecoder } from "./rds";
import { ToneDecoder } from "./tone";
import type { RdsStation, RdsStats } from "@sdr/shared";

/** Target intermediate (channel) rate per mode, before final resample to 48k. */
const TARGET_IF: Record<Mode, number> = {
  WFM: 256_000,
  NFM: 64_000,
  AM: 48_000,
  USB: 48_000,
  LSB: 48_000,
  CW: 48_000,
};

/** FM peak deviation per mode, for discriminator output scaling. */
const FM_DEVIATION: Record<string, number> = {
  WFM: 75_000,
  NFM: 5_000,
};

const MAX_DECIM_TAPS = 401;
const DEEMPHASIS_TAU = 75e-6; // 75 µs (Americas); use 50e-6 for EU

export interface DemodResult {
  audio: Float32Array;
  powerDb: number;
}

export class Demodulator {
  private mode: Mode = "WFM";
  private channelRate = 256_000;
  private decim!: ComplexDecimator;
  private resampler = new LinearResampler(256_000, AUDIO_RATE);

  // FM discriminator state
  private prevI = 0;
  private prevQ = 0;
  // WFM de-emphasis (1-pole) state
  private deemph = 0;
  private deemphA = 0;
  // AM DC-block state
  private dcPrevIn = 0;
  private dcPrevOut = 0;
  // Audio shaping FIR
  private audioFir!: RealFir;
  // Passband (Weaver) stage: shift by centre, low-pass half-width, shift back.
  private passDown = new Nco(256_000, 0);
  private passUp = new Nco(256_000, 0);
  private passI!: RealFir;
  private passQ!: RealFir;

  // Enhancement stages (bypassed unless enabled).
  private nb = new NoiseBlanker();
  private nbOn = false;
  private nr = new LmsDenoiser();
  private nrOn = false;
  private agc = new AudioAgc();
  private agcMode: AgcMode = "off";
  private notchOffsets: number[] = []; // Hz relative to VFO
  private notches: ComplexNotch[] = [];

  // RDS data decoder, fed the WFM multiplex (MPX) before de-emphasis.
  private rds = new RdsDecoder();
  // CTCSS/DCS decoder, fed the NFM discriminator output (sub-audible band).
  private tone = new ToneDecoder();

  constructor() {
    const bw = 200_000;
    this.configure("WFM", 1_024_000, -bw / 2, bw / 2);
  }

  configure(mode: Mode, fs: number, low: number, high: number) {
    this.mode = mode;
    if (high <= low) high = low + 1;
    const width = high - low;
    const center = (low + high) / 2;

    const target = TARGET_IF[mode];
    const decim = Math.max(1, Math.round(fs / target));
    this.channelRate = fs / decim;

    // Decimation low-pass must pass the whole passband (its furthest edge from DC).
    const maxExtent = Math.max(Math.abs(low), Math.abs(high), width / 2);
    const cutoff = Math.min(maxExtent, this.channelRate * 0.45);
    const transNorm = Math.max((this.channelRate * 0.5 - cutoff) / fs, 0.0008);
    let taps = tapsFor(transNorm);
    if (taps > MAX_DECIM_TAPS) taps = MAX_DECIM_TAPS;
    this.decim = new ComplexDecimator(designLowpass(taps, cutoff / fs), decim);

    this.resampler = new LinearResampler(this.channelRate, AUDIO_RATE);

    // Audio post-filter cutoff per mode.
    let audioCut: number;
    if (mode === "WFM") audioCut = 15_000;
    else if (mode === "NFM") audioCut = Math.min(4_000, width / 2);
    else if (mode === "AM") audioCut = Math.min(width / 2, 6_000);
    // SSB/CW: the recombined audio sits at [low, high], so its highest component
    // is max(|low|,|high|) — for CW the passband is offset up by CW_TONE, so a
    // plain `width` cutoff would roll off the beat tone itself.
    else audioCut = Math.min(Math.max(Math.abs(low), Math.abs(high)), 3_500);
    audioCut = Math.min(audioCut, this.channelRate * 0.45);
    this.audioFir = new RealFir(
      designLowpass(tapsFor(0.05), audioCut / this.channelRate),
    );

    // De-emphasis coefficient (WFM).
    this.deemphA = 1 - Math.exp(-1 / (this.channelRate * DEEMPHASIS_TAU));

    // RDS runs on the WFM multiplex at the channel rate; (re)configuring it also
    // clears any station decoded for the previous tuning.
    this.rds.configure(this.channelRate);

    // CTCSS/DCS rides the NFM discriminator output; (re)configuring clears any
    // tone detected for the previous tuning.
    this.tone.configure(this.channelRate);

    // Generalised Weaver passband: shift centre -> DC, low-pass ±width/2.
    this.passDown = new Nco(this.channelRate, -center);
    this.passUp = new Nco(this.channelRate, center);
    const passTaps = designLowpass(tapsFor(0.04), width / 2 / this.channelRate);
    this.passI = new RealFir(passTaps);
    this.passQ = new RealFir(passTaps.slice());

    if (this.agcMode !== "off") this.agc.configure(this.channelRate, this.agcMode);
    this.rebuildNotches();

    // reset transient state
    this.prevI = this.prevQ = 0;
    this.deemph = 0;
    this.dcPrevIn = this.dcPrevOut = 0;
  }

  // --- enhancement setters ---

  setNr(on: boolean, level?: number) {
    this.nrOn = on;
    if (level != null) this.nr.setLevel(level);
    if (on) this.nr.reset();
  }
  setNb(on: boolean, threshold?: number) {
    this.nbOn = on;
    if (threshold != null) this.nb.setThreshold(threshold);
  }
  setAgc(mode: AgcMode) {
    this.agcMode = mode;
    if (mode !== "off") {
      this.agc.configure(this.channelRate, mode);
      this.agc.reset();
    }
  }
  /** Notch positions as Hz offsets from the VFO (DC). */
  setNotchOffsets(offsets: number[]) {
    this.notchOffsets = offsets;
    this.rebuildNotches();
  }
  private rebuildNotches() {
    this.notches = this.notchOffsets.map(
      (off) => new ComplexNotch(off, this.channelRate),
    );
  }

  // --- RDS (broadcast-FM data) ---

  /** Decoded RDS station for the current tuning, or null (WFM only). */
  rdsStation(): RdsStation | null {
    return this.rds.snapshot();
  }
  /** RDS link-quality stats. */
  rdsStats(): RdsStats {
    return this.rds.stats();
  }
  /** Drop the decoded RDS station and re-acquire (call on retune within a band). */
  resetRds() {
    this.rds.reset();
  }
  /** One-line RDS reception health readout (for debugging). */
  rdsDiag(): string {
    return this.rds.diag();
  }

  // --- CTCSS/DCS (sub-audible tone, NFM) ---

  /** The sub-audible tone currently decoded on the channel, or null. */
  detectedTone(): ToneSquelch | null {
    return this.mode === "NFM" ? this.tone.detected() : null;
  }
  /** Whether the required tone-squelch tone is present right now. */
  toneMatches(want: ToneSquelch): boolean {
    return this.tone.matches(want);
  }
  /** Drop tone detection state (call on retune within a band). */
  resetTone() {
    this.tone.reset();
  }

  /** `iq` is interleaved complex at fs, signal of interest centered at DC. */
  process(iq: Float32Array): DemodResult {
    const ch = this.decim.process(iq); // interleaved complex at channelRate
    const n = ch.length / 2;
    const powerDb = channelPowerDb(ch);
    if (n === 0) return { audio: new Float32Array(0), powerDb };

    if (this.nbOn) this.nb.process(ch);
    for (const notch of this.notches) notch.process(ch);

    let audioCh: Float32Array;
    switch (this.mode) {
      case "WFM":
      case "NFM":
        audioCh = this.demodFm(ch, n);
        break;
      case "AM":
        audioCh = this.demodPassband(ch, n, true);
        break;
      case "USB":
      case "LSB":
      case "CW":
        audioCh = this.demodPassband(ch, n, false);
        break;
      default:
        audioCh = new Float32Array(n);
    }

    let shaped = this.audioFir.process(audioCh);
    if (this.nrOn) shaped = this.nr.process(shaped);
    if (this.agcMode !== "off") shaped = this.agc.process(shaped);
    const audio = this.resampler.process(shaped);
    return { audio, powerDb };
  }

  private demodFm(ch: Float32Array, n: number): Float32Array {
    const out = new Float32Array(n);
    let pI = this.prevI;
    let pQ = this.prevQ;
    const dev = FM_DEVIATION[this.mode] ?? 5_000;
    const scale = this.channelRate / (2 * Math.PI * dev);
    for (let k = 0; k < n; k++) {
      const i = ch[2 * k]!;
      const q = ch[2 * k + 1]!;
      // s[k] * conj(s[k-1])
      const re = i * pI + q * pQ;
      const im = q * pI - i * pQ;
      out[k] = Math.atan2(im, re) * scale;
      pI = i;
      pQ = q;
    }
    this.prevI = pI;
    this.prevQ = pQ;

    if (this.mode === "NFM") {
      // Sub-audible CTCSS/DCS lives in the raw discriminator output below the
      // voice band — feed it to the tone decoder before any audio shaping.
      this.tone.process(out, n);
    }

    if (this.mode === "WFM") {
      // The raw discriminator output is the full FM multiplex — feed it to the
      // RDS decoder before de-emphasis rolls off the 57 kHz subcarrier.
      this.rds.process(out, n);
      // 1-pole de-emphasis
      let y = this.deemph;
      const a = this.deemphA;
      for (let k = 0; k < n; k++) {
        y += a * (out[k]! - y);
        out[k] = y;
      }
      this.deemph = y;
    }
    return out;
  }

  // Generalised Weaver passband demod, shared by AM and SSB/CW. Shifts the
  // passband centre to DC, low-passes the half-width (sharp channel filter), then
  // either envelope-detects (AM) or shifts back and takes the real part (SSB/CW).
  // `center` (the IF shift) is baked into passDown/passUp at configure time.
  private demodPassband(ch: Float32Array, n: number, am: boolean): Float32Array {
    const down = this.passDown.mix(ch, new Float32Array(ch.length));
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      I[k] = down[2 * k]!;
      Q[k] = down[2 * k + 1]!;
    }
    const Ilp = this.passI.process(I);
    const Qlp = this.passQ.process(Q);

    const out = new Float32Array(n);
    if (am) {
      // Envelope detection is non-coherent, so the IF shift doesn't matter; an
      // asymmetric passband simply trims one sideband. DC-block the result.
      let pin = this.dcPrevIn;
      let pout = this.dcPrevOut;
      for (let k = 0; k < n; k++) {
        const env = Math.hypot(Ilp[k]!, Qlp[k]!);
        const y = env - pin + 0.999 * pout;
        pin = env;
        pout = y;
        out[k] = y;
      }
      this.dcPrevIn = pin;
      this.dcPrevOut = pout;
      return out;
    }

    // SSB/CW: shift the selected passband back up and take the real part.
    const recomb = new Float32Array(ch.length);
    for (let k = 0; k < n; k++) {
      recomb[2 * k] = Ilp[k]!;
      recomb[2 * k + 1] = Qlp[k]!;
    }
    const up = this.passUp.mix(recomb, new Float32Array(ch.length));
    for (let k = 0; k < n; k++) out[k] = up[2 * k]! * 2; // *2 restores level
    return out;
  }
}

/** Mean power of an interleaved complex buffer, in dB (full-scale = 0 dB). */
export function channelPowerDb(ch: Float32Array): number {
  const n = ch.length / 2;
  if (n === 0) return -120;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const i = ch[2 * k]!;
    const q = ch[2 * k + 1]!;
    sum += i * i + q * q;
  }
  const p = sum / n;
  return 10 * Math.log10(p + 1e-12);
}
