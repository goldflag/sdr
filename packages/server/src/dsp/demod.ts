// Per-mode demodulator. Input is interleaved complex IQ at the dongle sample
// rate, already frequency-shifted so the signal of interest sits at DC (the
// session's VFO NCO does that). Output is mono audio at AUDIO_RATE plus the
// in-channel power in dB (for squelch / S-meter).
//
// Pipeline: ComplexDecimator (fs -> channelRate) -> mode demod -> LinearResampler.

import type { Mode } from "@sdr/shared";
import { AUDIO_RATE } from "@sdr/shared";
import {
  ComplexDecimator,
  RealFir,
  designLowpass,
  tapsFor,
} from "./filters";
import { LinearResampler } from "./resample";
import { Nco } from "./nco";

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
  // SSB/CW Weaver state
  private weaverDown = new Nco(256_000, 0);
  private weaverUp = new Nco(256_000, 0);
  private ssbI!: RealFir;
  private ssbQ!: RealFir;

  constructor() {
    this.configure("WFM", 1_024_000, 200_000);
  }

  configure(mode: Mode, fs: number, bandwidth: number) {
    this.mode = mode;

    const target = TARGET_IF[mode];
    const decim = Math.max(1, Math.round(fs / target));
    this.channelRate = fs / decim;

    // Decimation low-pass cutoff. SSB/CW pass the full ±bw so the Weaver stage
    // can select a sideband; other modes pass bw/2.
    const wideForSsb = mode === "USB" || mode === "LSB" || mode === "CW";
    const cutoff = Math.min(
      wideForSsb ? bandwidth : bandwidth / 2,
      this.channelRate * 0.45,
    );
    const transNorm = Math.max(
      (this.channelRate * 0.5 - cutoff) / fs,
      0.0008,
    );
    let taps = tapsFor(transNorm);
    if (taps > MAX_DECIM_TAPS) taps = MAX_DECIM_TAPS;
    this.decim = new ComplexDecimator(designLowpass(taps, cutoff / fs), decim);

    this.resampler = new LinearResampler(this.channelRate, AUDIO_RATE);

    // Audio post-filter cutoff per mode.
    let audioCut: number;
    if (mode === "WFM") audioCut = 15_000;
    else if (mode === "NFM") audioCut = Math.min(4_000, bandwidth / 2);
    else if (mode === "AM") audioCut = Math.min(bandwidth / 2, 6_000);
    else audioCut = Math.min(bandwidth, 3_500); // SSB/CW
    audioCut = Math.min(audioCut, this.channelRate * 0.45);
    this.audioFir = new RealFir(
      designLowpass(tapsFor(0.05), audioCut / this.channelRate),
    );

    // De-emphasis coefficient (WFM).
    this.deemphA = 1 - Math.exp(-1 / (this.channelRate * DEEMPHASIS_TAU));

    // Weaver SSB: offset = bw/2, complex LPF cutoff = bw/2.
    const fo = bandwidth / 2;
    this.weaverDown = new Nco(this.channelRate, -fo);
    this.weaverUp = new Nco(this.channelRate, fo);
    const ssbTaps = designLowpass(tapsFor(0.04), (bandwidth / 2) / this.channelRate);
    this.ssbI = new RealFir(ssbTaps);
    this.ssbQ = new RealFir(ssbTaps.slice());

    // reset transient state
    this.prevI = this.prevQ = 0;
    this.deemph = 0;
    this.dcPrevIn = this.dcPrevOut = 0;
  }

  /** `iq` is interleaved complex at fs, signal of interest centered at DC. */
  process(iq: Float32Array): DemodResult {
    const ch = this.decim.process(iq); // interleaved complex at channelRate
    const n = ch.length / 2;
    const powerDb = channelPowerDb(ch);
    if (n === 0) return { audio: new Float32Array(0), powerDb };

    let audioCh: Float32Array;
    switch (this.mode) {
      case "WFM":
      case "NFM":
        audioCh = this.demodFm(ch, n);
        break;
      case "AM":
        audioCh = this.demodAm(ch, n);
        break;
      case "USB":
      case "LSB":
      case "CW":
        audioCh = this.demodSsb(ch, n, this.mode === "LSB");
        break;
      default:
        audioCh = new Float32Array(n);
    }

    const shaped = this.audioFir.process(audioCh);
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

    if (this.mode === "WFM") {
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

  private demodAm(ch: Float32Array, n: number): Float32Array {
    const out = new Float32Array(n);
    let pin = this.dcPrevIn;
    let pout = this.dcPrevOut;
    for (let k = 0; k < n; k++) {
      const i = ch[2 * k]!;
      const q = ch[2 * k + 1]!;
      const env = Math.hypot(i, q);
      // DC block: y[n] = x[n] - x[n-1] + r*y[n-1]
      const y = env - pin + 0.999 * pout;
      pin = env;
      pout = y;
      out[k] = y;
    }
    this.dcPrevIn = pin;
    this.dcPrevOut = pout;
    return out;
  }

  // Weaver third-method SSB: shift the wanted sideband to DC, complex low-pass,
  // shift back and take the real part. `lsb` flips the mixing direction.
  private demodSsb(ch: Float32Array, n: number, lsb: boolean): Float32Array {
    const down = new Float32Array(ch.length);
    // mix down by fo (USB) / up by fo (LSB)
    if (lsb) this.weaverUp.mix(ch, down);
    else this.weaverDown.mix(ch, down);

    // split to real I/Q, low-pass each (complex low-pass), recombine
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      I[k] = down[2 * k]!;
      Q[k] = down[2 * k + 1]!;
    }
    const Ilp = this.ssbI.process(I);
    const Qlp = this.ssbQ.process(Q);

    const recomb = new Float32Array(ch.length);
    for (let k = 0; k < n; k++) {
      recomb[2 * k] = Ilp[k]!;
      recomb[2 * k + 1] = Qlp[k]!;
    }
    // mix back up (USB) / down (LSB) and take real part
    const up = new Float32Array(ch.length);
    if (lsb) this.weaverDown.mix(recomb, up);
    else this.weaverUp.mix(recomb, up);

    const out = new Float32Array(n);
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
