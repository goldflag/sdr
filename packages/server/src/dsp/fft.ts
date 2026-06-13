// Spectrum analyzer: Welch-averaged windowed FFTs. Every incoming IQ block is
// FFT'd (in `size`-sample chunks) and its power accumulated, so a pulled frame
// is the mean spectrum of everything received since the last pull rather than
// a 2 ms snapshot — far lower noise variance at the same display rate. On top
// of that sits a user-adjustable exponential average across frames (the
// "Averaging" control). The session pulls frames at a fixed display rate.

import FFT from "fft.js";

/** Cap on FFT'd blocks per pulled frame, to bound CPU at high sample rates. */
const MAX_BLOCKS_PER_FRAME = 64;

export class SpectrumAnalyzer {
  private fft: FFT;
  private size: number;
  private window: Float32Array;
  private pending: Float32Array; // partial input block, interleaved complex
  private pendingFill = 0; // floats buffered (2 per sample)
  private accum: Float64Array; // summed linear power per (unshifted) bin
  private accumBlocks = 0;
  private ema: Float64Array | null = null; // cross-frame average, linear power
  private emaAlpha = 1;
  private out: Float64Array;
  private input: Float64Array;

  constructor(size = 2048, avgLevel = 0.2) {
    this.size = size;
    this.fft = new FFT(size);
    this.window = hann(size);
    this.pending = new Float32Array(size * 2);
    this.accum = new Float64Array(size);
    this.out = new Float64Array(size * 2);
    this.input = new Float64Array(size * 2);
    this.setAvg(avgLevel);
  }

  get binCount(): number {
    return this.size;
  }

  /** Cross-frame averaging strength, 0 (off) .. 1 (very slow). */
  setAvg(level: number) {
    const l = Math.min(1, Math.max(0, level));
    // 0 -> alpha 1 (each frame stands alone), 1 -> alpha 0.02 (~2.5 s memory).
    this.emaAlpha = Math.pow(0.02, l);
  }

  /** Drop all buffered/accumulated state (call when the input stream jumps,
   *  e.g. switching between the full-band and zoom pipelines). */
  reset() {
    this.pendingFill = 0;
    this.accum.fill(0);
    this.accumBlocks = 0;
    this.ema = null;
  }

  setSize(size: number) {
    if (size === this.size) return;
    this.size = size;
    this.fft = new FFT(size);
    this.window = hann(size);
    this.pending = new Float32Array(size * 2);
    this.pendingFill = 0;
    this.accum = new Float64Array(size);
    this.accumBlocks = 0;
    this.out = new Float64Array(size * 2);
    this.input = new Float64Array(size * 2);
    this.ema = null;
  }

  /** Feed interleaved complex IQ; every complete `size`-sample block is FFT'd
   *  and folded into the running average for the next frame. */
  push(iq: Float32Array) {
    const need = this.size * 2;
    let off = 0;
    while (off < iq.length) {
      const take = Math.min(need - this.pendingFill, iq.length - off);
      this.pending.set(iq.subarray(off, off + take), this.pendingFill);
      this.pendingFill += take;
      off += take;
      if (this.pendingFill === need) {
        this.pendingFill = 0;
        if (this.accumBlocks < MAX_BLOCKS_PER_FRAME) this.accumulateBlock();
      }
    }
  }

  private accumulateBlock() {
    const N = this.size;
    const win = this.window;
    const inp = this.input;
    const buf = this.pending;
    for (let i = 0; i < N; i++) {
      const w = win[i]!;
      inp[2 * i] = buf[2 * i]! * w;
      inp[2 * i + 1] = buf[2 * i + 1]! * w;
    }
    this.fft.transform(this.out, inp);
    for (let j = 0; j < N; j++) {
      const re = this.out[2 * j]!;
      const im = this.out[2 * j + 1]!;
      this.accum[j]! += re * re + im * im;
    }
    this.accumBlocks++;
  }

  /** Returns fftshifted power-in-dB bins, or null if no block completed yet. */
  getFrame(): Float32Array | null {
    if (this.accumBlocks === 0) return null;
    const N = this.size;
    const norm = 1 / (N * N) / this.accumBlocks;
    const half = N >> 1;

    if (!this.ema || this.ema.length !== N) {
      this.ema = new Float64Array(N);
      for (let j = 0; j < N; j++) this.ema[j] = this.accum[j]! * norm;
    } else {
      const a = this.emaAlpha;
      for (let j = 0; j < N; j++) {
        this.ema[j]! += a * (this.accum[j]! * norm - this.ema[j]!);
      }
    }
    this.accum.fill(0);
    this.accumBlocks = 0;

    const bins = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      // fftshift: output index j (low->high freq) <- source bin (j+half)%N
      bins[j] = 10 * Math.log10(this.ema[(j + half) % N]! + 1e-12);
    }
    return bins;
  }
}

function hann(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
  }
  return w;
}
