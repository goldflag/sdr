// Spectrum analyzer: buffers the most recent IQ block, applies a Hann window,
// runs an FFT, and returns fftshifted power in dB ordered low->high frequency.
// The session pulls a frame at a fixed display rate (it doesn't FFT every block).

import FFT from "fft.js";

export class SpectrumAnalyzer {
  private fft: FFT;
  private size: number;
  private window: Float32Array;
  private buf: Float32Array; // interleaved complex, length 2*size
  private filled = 0;
  private out: Float64Array;
  private input: Float64Array;
  private avg: Float32Array | null = null;
  private avgAlpha: number;

  constructor(size = 2048, avgAlpha = 0.5) {
    this.size = size;
    this.fft = new FFT(size);
    this.window = hann(size);
    this.buf = new Float32Array(size * 2);
    this.out = new Float64Array(size * 2);
    this.input = new Float64Array(size * 2);
    this.avgAlpha = avgAlpha;
  }

  get binCount(): number {
    return this.size;
  }

  setSize(size: number) {
    if (size === this.size) return;
    this.size = size;
    this.fft = new FFT(size);
    this.window = hann(size);
    this.buf = new Float32Array(size * 2);
    this.out = new Float64Array(size * 2);
    this.input = new Float64Array(size * 2);
    this.filled = 0;
    this.avg = null;
  }

  /** Feed interleaved complex IQ; keeps only the most recent `size` samples. */
  push(iq: Float32Array) {
    const need = this.size * 2;
    if (iq.length >= need) {
      this.buf.set(iq.subarray(iq.length - need));
      this.filled = need;
    } else {
      this.buf.copyWithin(0, iq.length);
      this.buf.set(iq, need - iq.length);
      this.filled = Math.min(need, this.filled + iq.length);
    }
  }

  /** Returns fftshifted power-in-dB bins, or null if not enough samples yet. */
  getFrame(): Float32Array | null {
    if (this.filled < this.size * 2) return null;
    const N = this.size;
    const win = this.window;
    const inp = this.input;
    for (let i = 0; i < N; i++) {
      const w = win[i]!;
      inp[2 * i] = this.buf[2 * i]! * w;
      inp[2 * i + 1] = this.buf[2 * i + 1]! * w;
    }
    this.fft.transform(this.out, inp);

    const bins = new Float32Array(N);
    const norm = 1 / (N * N);
    const half = N >> 1;
    for (let j = 0; j < N; j++) {
      // fftshift: output index j (low->high freq) <- source bin (j+half)%N
      const src = (j + half) % N;
      const re = this.out[2 * src]!;
      const im = this.out[2 * src + 1]!;
      const power = (re * re + im * im) * norm;
      bins[j] = 10 * Math.log10(power + 1e-12);
    }

    if (this.avg && this.avg.length === N) {
      const a = this.avgAlpha;
      for (let j = 0; j < N; j++) {
        this.avg[j] = this.avg[j]! + a * (bins[j]! - this.avg[j]!);
        bins[j] = this.avg[j]!;
      }
    } else {
      this.avg = bins.slice();
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
