// Optional audio/IF enhancement stages: noise reduction, noise blanker, and
// audio AGC. Each is a small streaming class that keeps state across blocks so
// it can run on the continuous demod stream. All are bypassed unless enabled.

/**
 * LMS adaptive noise reduction (an adaptive line enhancer). An adaptive FIR
 * predicts each audio sample from a decorrelated slice of its own past. Tonal /
 * correlated content (voice, carriers, CW) is predictable and survives; broadband
 * hiss is not and is suppressed. We output the *prediction* (the de-noised
 * signal), blended with the input by `strength`.
 *
 * This is the time-domain cousin of spectral subtraction — no block latency or
 * musical-noise artifacts, and it adapts continuously to the noise floor.
 */
export class LmsDenoiser {
  private static readonly TAPS = 32;
  private static readonly DELTA = 1; // decorrelation delay (samples)
  private readonly w = new Float32Array(LmsDenoiser.TAPS);
  // history[0] is the most recent input sample.
  private readonly hist = new Float32Array(LmsDenoiser.TAPS + LmsDenoiser.DELTA);
  private mu = 0.3;
  private strength = 0.7;

  /** `level` 0..1 sets how aggressive the reduction is. */
  setLevel(level: number) {
    const l = Math.min(1, Math.max(0, level));
    this.strength = 0.3 + 0.6 * l; // 0.3..0.9 mix toward the prediction
    this.mu = 0.1 + 0.4 * l; // adaptation speed
  }

  reset() {
    this.w.fill(0);
    this.hist.fill(0);
  }

  process(x: Float32Array): Float32Array {
    const T = LmsDenoiser.TAPS;
    const D = LmsDenoiser.DELTA;
    const w = this.w;
    const hist = this.hist;
    const out = new Float32Array(x.length);
    const mix = this.strength;

    for (let n = 0; n < x.length; n++) {
      // shift newest sample into history
      for (let i = hist.length - 1; i > 0; i--) hist[i] = hist[i - 1]!;
      hist[0] = x[n]!;

      // predict from the delayed slice; track its power for NLMS step size
      let y = 0;
      let pow = 1e-6;
      for (let k = 0; k < T; k++) {
        const h = hist[D + k]!;
        y += w[k]! * h;
        pow += h * h;
      }
      const e = x[n]! - y;
      const g = this.mu / pow;
      for (let k = 0; k < T; k++) w[k] = w[k]! + g * e * hist[D + k]!;

      out[n] = x[n]! * (1 - mix) + y * mix;
    }
    return out;
  }
}

/**
 * Impulse noise blanker. Tracks a slow running mean of the complex IF magnitude;
 * any sample spiking well above it (ignition noise, power-line arcing) is blanked
 * to zero. Operates in place on the interleaved complex channel stream, before
 * demodulation, so the impulse never smears through the discriminator.
 */
export class NoiseBlanker {
  private avg = 0;
  private threshold = 4; // blank when mag > threshold * running mean

  setThreshold(t: number) {
    this.threshold = Math.max(1.5, t);
  }
  reset() {
    this.avg = 0;
  }

  /** `ch` is interleaved complex [I,Q,...]; modified in place. */
  process(ch: Float32Array) {
    const n = ch.length / 2;
    const thr = this.threshold;
    for (let k = 0; k < n; k++) {
      const i = ch[2 * k]!;
      const q = ch[2 * k + 1]!;
      const mag = Math.hypot(i, q);
      if (this.avg === 0) this.avg = mag;
      if (mag > thr * this.avg) {
        ch[2 * k] = 0;
        ch[2 * k + 1] = 0;
      } else {
        // only quiet samples update the noise estimate
        this.avg += 0.02 * (mag - this.avg);
      }
    }
  }
}

export type AgcMode = "off" | "fast" | "medium" | "slow";

interface AgcParams {
  release: number; // seconds for the gain to recover after a loud passage
  hang: number; // seconds to hold gain before recovering
}

const AGC_PRESETS: Record<Exclude<AgcMode, "off">, AgcParams> = {
  fast: { release: 0.1, hang: 0.05 },
  medium: { release: 0.5, hang: 0.25 },
  slow: { release: 2.0, hang: 0.6 },
};

/**
 * Audio-domain AGC: keeps perceived loudness even as signals fade or vary, the
 * way a receiver's audio AGC does. Fast attack clamps sudden peaks; a hang timer
 * then holds the gain before a slow release brings it back up — so it doesn't
 * pump the noise floor up during pauses between words. Distinct from the tuner's
 * RF gain, which sets the front-end amplifier.
 */
export class AudioAgc {
  private env = 1e-3;
  private gain = 1;
  private hangLeft = 0;
  private attackC = 0;
  private releaseC = 0;
  private hangSamples = 0;
  private readonly target = 0.3;
  private readonly maxGain = 1000; // ~60 dB

  configure(fs: number, mode: Exclude<AgcMode, "off">) {
    const p = AGC_PRESETS[mode];
    this.attackC = 1 - Math.exp(-1 / (0.005 * fs)); // 5 ms attack
    this.releaseC = 1 - Math.exp(-1 / (p.release * fs));
    this.hangSamples = Math.round(p.hang * fs);
  }
  reset() {
    this.env = 1e-3;
    this.gain = 1;
    this.hangLeft = 0;
  }

  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    for (let n = 0; n < x.length; n++) {
      const mag = Math.abs(x[n]!);
      if (mag > this.env) {
        this.env += this.attackC * (mag - this.env);
        this.hangLeft = this.hangSamples;
      } else if (this.hangLeft > 0) {
        this.hangLeft--;
      } else {
        this.env += this.releaseC * (mag - this.env);
      }
      let desired = this.target / (this.env + 1e-4);
      if (desired > this.maxGain) desired = this.maxGain;
      // smooth the gain itself to avoid zipper noise
      this.gain += 0.05 * (desired - this.gain);
      out[n] = x[n]! * this.gain;
    }
    return out;
  }
}
