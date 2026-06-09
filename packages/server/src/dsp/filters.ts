// FIR filter design + streaming filters/decimators used by the demod pipeline.

/**
 * Windowed-sinc low-pass FIR. `cutoffNorm` is the cutoff as a fraction of the
 * sample rate (0..0.5). Uses a Hamming window. `numTaps` should be odd for a
 * symmetric (linear-phase) filter.
 */
export function designLowpass(numTaps: number, cutoffNorm: number): Float32Array {
  if (numTaps % 2 === 0) numTaps += 1;
  const h = new Float32Array(numTaps);
  const m = numTaps - 1;
  const wc = 2 * Math.PI * cutoffNorm;
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - m / 2;
    const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / m); // Hamming
    h[n] = sinc * win;
    sum += h[n]!;
  }
  // Normalize for unity DC gain.
  for (let n = 0; n < numTaps; n++) h[n]! /= sum;
  return h;
}

/** Rough tap count for a transition band of ~`transNorm` (fraction of fs). */
export function tapsFor(transNorm: number): number {
  const n = Math.ceil(3.3 / Math.max(transNorm, 1e-4));
  return n % 2 === 0 ? n + 1 : n;
}

/**
 * Streaming complex FIR low-pass + integer decimator. Maintains state across
 * calls so a continuous IQ stream can be processed in arbitrary chunks.
 * Input/output are interleaved complex [I, Q, ...].
 */
export class ComplexDecimator {
  private taps: Float32Array;
  private readonly T: number;
  private readonly D: number;
  private tail: Float32Array; // last (T-1) complex samples, interleaved
  private phase = 0; // index of next output within the next input block

  constructor(taps: Float32Array, decim: number) {
    this.taps = taps;
    this.T = taps.length;
    this.D = decim;
    this.tail = new Float32Array((this.T - 1) * 2);
  }

  process(input: Float32Array): Float32Array {
    const T = this.T;
    const D = this.D;
    const N = input.length / 2; // input complex sample count
    // work = [tail | input], interleaved complex, length (T-1 + N) complex
    const work = new Float32Array(this.tail.length + input.length);
    work.set(this.tail, 0);
    work.set(input, this.tail.length);

    const outCount = Math.max(0, Math.ceil((N - this.phase) / D));
    const out = new Float32Array(outCount * 2);
    const h = this.taps;

    let o = 0;
    let n = this.phase;
    for (; n < N; n += D) {
      let accI = 0;
      let accQ = 0;
      // y[n] = sum_k h[k] * work[(n + (T-1) - k)]  (complex index)
      for (let k = 0; k < T; k++) {
        const j = (n + (T - 1) - k) * 2;
        const hk = h[k]!;
        accI += hk * work[j]!;
        accQ += hk * work[j + 1]!;
      }
      out[o++] = accI;
      out[o++] = accQ;
    }

    this.phase = n - N; // carry remainder into next block (0..D-1)
    // new tail = last (T-1) complex samples of work
    this.tail = work.slice(work.length - (T - 1) * 2);
    return out.subarray(0, o);
  }
}

/**
 * Narrow notch on an interleaved complex stream, used to null a single carrier
 * or heterodyne at a chosen offset from DC. Works by shifting the target down to
 * DC, removing it with a 1-pole complex high-pass, then shifting back — i.e. a
 * band-stop a few tens of Hz wide centered on `offsetHz`. Operates in place.
 */
export class ComplexNotch {
  private cos = 1;
  private sin = 0;
  private stepCos = 1;
  private stepSin = 0;
  private n = 0;
  // high-pass (DC-removal) state, on the down-shifted I/Q
  private lpI = 0;
  private lpQ = 0;
  private a: number;

  constructor(offsetHz: number, sampleRate: number, widthHz = 60) {
    this.setFreq(offsetHz, sampleRate);
    // 1-pole corner ~ a*fs/(2π); pick `a` for the requested half-width.
    this.a = Math.min(0.5, (2 * Math.PI * widthHz) / sampleRate);
  }

  setFreq(offsetHz: number, sampleRate: number) {
    const w = (-2 * Math.PI * offsetHz) / sampleRate; // shift target -> DC
    this.stepCos = Math.cos(w);
    this.stepSin = Math.sin(w);
  }

  process(ch: Float32Array) {
    let { cos, sin } = this;
    const sc = this.stepCos;
    const ss = this.stepSin;
    const a = this.a;
    for (let k = 0; k < ch.length; k += 2) {
      const re = ch[k]!;
      const im = ch[k + 1]!;
      // shift down so the notch target lands at DC
      const dI = re * cos - im * sin;
      const dQ = re * sin + im * cos;
      // complex high-pass: remove the (now-DC) target
      this.lpI += a * (dI - this.lpI);
      this.lpQ += a * (dQ - this.lpQ);
      const hI = dI - this.lpI;
      const hQ = dQ - this.lpQ;
      // shift back up (conjugate rotation)
      ch[k] = hI * cos + hQ * sin;
      ch[k + 1] = -hI * sin + hQ * cos;
      // advance oscillator
      const nc = cos * sc - sin * ss;
      const nsv = cos * ss + sin * sc;
      cos = nc;
      sin = nsv;
      if ((this.n++ & 0x3ff) === 0) {
        const mag = Math.hypot(cos, sin) || 1;
        cos /= mag;
        sin /= mag;
      }
    }
    this.cos = cos;
    this.sin = sin;
  }
}

/** Streaming real FIR low-pass (no decimation), for audio shaping. */
export class RealFir {
  private readonly T: number;
  private tail: Float32Array;

  constructor(private taps: Float32Array) {
    this.T = taps.length;
    this.tail = new Float32Array(this.T - 1);
  }

  process(input: Float32Array): Float32Array {
    const T = this.T;
    const work = new Float32Array(this.tail.length + input.length);
    work.set(this.tail, 0);
    work.set(input, this.tail.length);
    const out = new Float32Array(input.length);
    const h = this.taps;
    for (let n = 0; n < input.length; n++) {
      let acc = 0;
      for (let k = 0; k < T; k++) acc += h[k]! * work[n + (T - 1) - k]!;
      out[n] = acc;
    }
    this.tail = work.slice(work.length - (T - 1));
    return out;
  }
}
