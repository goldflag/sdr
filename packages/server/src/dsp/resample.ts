// Fractional sample-rate converter (linear interpolation) for the final audio
// stage, taking the demodulator's intermediate rate to exactly AUDIO_RATE.
// Adequate for voice once the signal is already band-limited upstream.

export class LinearResampler {
  private prev = 0;
  private pos = 0; // fractional read position into [prev, ...input]
  private ratio: number; // input samples consumed per output sample

  constructor(
    private inRate: number,
    private outRate: number,
  ) {
    this.ratio = inRate / outRate;
  }

  setRates(inRate: number, outRate: number) {
    if (inRate === this.inRate && outRate === this.outRate) return;
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return input;
    const work = new Float32Array(input.length + 1);
    work[0] = this.prev;
    work.set(input, 1);

    const ratio = this.ratio;
    const last = work.length - 1;
    const maxOut = Math.max(0, Math.ceil((last - this.pos) / ratio) + 1);
    const out = new Float32Array(maxOut);

    let pos = this.pos;
    let o = 0;
    while (pos < last) {
      const i = pos | 0;
      const f = pos - i;
      out[o++] = work[i]! * (1 - f) + work[i + 1]! * f;
      pos += ratio;
    }

    this.prev = work[last]!;
    this.pos = pos - last; // offset beyond last sample, carried to next block
    return out.subarray(0, o);
  }
}

/** Converts a Float32 [-1,1] buffer to Int16 PCM with clipping. */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i]!;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = (s * 32767) | 0;
  }
  return out;
}
