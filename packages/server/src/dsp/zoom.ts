// Zoom-FFT: a higher-resolution spectrum of a sub-window of the captured band.
// Stretching the full-band FFT just magnifies its 2048 bins into blocky pixels;
// instead this shifts the requested window to DC, decimates down to roughly the
// window's width, and FFTs that — so the same 2048 bins now span a fraction of
// the band and resolve individual narrow signals (e.g. CW, SSB).
//
//   band IQ ──► Nco (window centre → DC) ──► CascadeDecimator (÷2^k) ──► SpectrumAnalyzer
//
// Decimation is a cascade of ÷2 stages so the expensive wide-rate filtering
// stays short: the window the user sees is narrower than the decimated output
// (which is rounded up to the nearest power of two), so each stage's modest
// anti-alias filter only lets aliasing fold into the unused guard band at the
// frame edges, never into the displayed centre.

import { Nco } from "./nco";
import { ComplexDecimator, designLowpass } from "./filters";
import { SpectrumAnalyzer } from "./fft";
import type { SpectrumView } from "@sdr/shared";

const ZOOM_FFT_SIZE = 2048;
const MAX_STAGES = 8; // ÷256 max; the client tops out around ÷64 (100× zoom)
// Short per-÷2 anti-alias filter. Aliasing folds to the frame edges (the guard
// band outside the displayed window), so a gentle filter is fine for a display.
const STAGE_TAPS = 31;

/** Cascade of ÷2 complex decimators (total ÷2^stages). */
class CascadeDecimator {
  private stages: ComplexDecimator[] = [];

  constructor(stages: number) {
    const taps = designLowpass(STAGE_TAPS, 0.25); // cutoff at ¼ input rate
    for (let i = 0; i < stages; i++) {
      this.stages.push(new ComplexDecimator(taps, 2));
    }
  }

  process(iq: Float32Array): Float32Array {
    let x = iq;
    for (const s of this.stages) x = s.process(x);
    return x;
  }
}

export class ZoomSpectrum {
  private nco: Nco | null = null;
  private cascade: CascadeDecimator | null = null;
  private analyzer = new SpectrumAnalyzer(ZOOM_FFT_SIZE);
  private active = false;
  private frameCenterHz = 0;
  private outRate = 0;
  private avg = 0.2;

  get isActive(): boolean {
    return this.active;
  }

  setAvg(level: number) {
    this.avg = level;
    this.analyzer.setAvg(level);
  }

  /**
   * Point the zoom pipeline at `view` within a band of `sampleRate` centred on
   * `bandCenterHz`. Returns true if a real zoom is active; false (and inactive)
   * when there's no view or the window is too wide to be worth decimating.
   */
  configure(
    sampleRate: number,
    bandCenterHz: number,
    view: SpectrumView | null,
    avg: number,
  ): boolean {
    this.avg = avg;
    if (!view || !(view.spanHz > 0)) {
      this.reset();
      return false;
    }
    const k = Math.min(
      MAX_STAGES,
      Math.floor(Math.log2(sampleRate / view.spanHz)),
    );
    if (k <= 0) {
      // Less than 2× — the full-band frame stretched by the client is fine.
      this.reset();
      return false;
    }
    const decim = 2 ** k;
    this.outRate = sampleRate / decim;
    // Keep the (wider-than-asked) output window inside the captured band.
    const maxOffset = (sampleRate - this.outRate) / 2;
    const offset = clamp(view.centerHz - bandCenterHz, -maxOffset, maxOffset);
    this.frameCenterHz = bandCenterHz + offset;
    this.nco = new Nco(sampleRate, -offset); // bring the window centre to DC
    this.cascade = new CascadeDecimator(k);
    this.analyzer = new SpectrumAnalyzer(ZOOM_FFT_SIZE, this.avg);
    this.active = true;
    return true;
  }

  push(iq: Float32Array) {
    if (!this.active || !this.nco || !this.cascade) return;
    const shifted = this.nco.mix(iq, new Float32Array(iq.length));
    const dec = this.cascade.process(shifted);
    if (dec.length > 0) this.analyzer.push(dec);
  }

  /** A zoomed FFT frame (centre/rate describe the window), or null if not ready. */
  getFrame(): { centerHz: number; sampleRate: number; bins: Float32Array } | null {
    if (!this.active) return null;
    const bins = this.analyzer.getFrame();
    if (!bins) return null;
    return { centerHz: this.frameCenterHz, sampleRate: this.outRate, bins };
  }

  reset() {
    this.active = false;
    this.nco = null;
    this.cascade = null;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
