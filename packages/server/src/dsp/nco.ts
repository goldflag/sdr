// Numerically-controlled oscillator: mixes (frequency-shifts) a complex signal.
// Used to translate a VFO offset within the captured band down to DC (and for
// the Weaver SSB demodulator). Uses incremental complex rotation instead of a
// Math.cos/sin per sample, with periodic renormalization to bound drift.

export class Nco {
  private cos = 1;
  private sin = 0;
  private stepCos = 1;
  private stepSin = 0;
  private freq = 0;
  private sampleRate: number;
  private n = 0;

  constructor(sampleRate: number, freqHz = 0) {
    this.sampleRate = sampleRate;
    this.setFreq(freqHz);
  }

  setSampleRate(sr: number) {
    this.sampleRate = sr;
    this.setFreq(this.freq);
  }

  setFreq(freqHz: number) {
    this.freq = freqHz;
    const w = (2 * Math.PI * freqHz) / this.sampleRate;
    this.stepCos = Math.cos(w);
    this.stepSin = Math.sin(w);
  }

  /**
   * Mixes interleaved complex input by this oscillator's frequency, writing
   * interleaved complex output (may be the same buffer). Positive freq shifts
   * the spectrum up; use a negative freq to bring an offset down to DC.
   */
  mix(input: Float32Array, output: Float32Array = input): Float32Array {
    let { cos, sin } = this;
    const sc = this.stepCos;
    const ss = this.stepSin;
    for (let i = 0; i < input.length; i += 2) {
      const re = input[i]!;
      const im = input[i + 1]!;
      // (re + j im) * (cos + j sin)
      output[i] = re * cos - im * sin;
      output[i + 1] = re * sin + im * cos;
      // advance oscillator: (cos + j sin) *= (sc + j ss)
      const nc = cos * sc - sin * ss;
      const nsv = cos * ss + sin * sc;
      cos = nc;
      sin = nsv;
      if ((this.n++ & 0x3ff) === 0) {
        // renormalize to unit magnitude
        const mag = Math.hypot(cos, sin) || 1;
        cos /= mag;
        sin /= mag;
      }
    }
    this.cos = cos;
    this.sin = sin;
    return output;
  }
}
