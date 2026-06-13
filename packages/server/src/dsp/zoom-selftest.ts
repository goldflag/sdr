// Synthetic self-test for the zoom-FFT pipeline. No hardware required.
// Run with: bun run src/dsp/zoom-selftest.ts  (or `bun run test:zoom`)
//
// Verifies that zooming actually raises resolution: a window decimated to ~64
// kHz resolves two tones 1.5 kHz apart that the full-band 500 Hz RBW would
// barely separate, the peak lands at the right absolute frequency, and the
// output window is clamped to stay inside the captured band.

import { ZoomSpectrum } from "./zoom";

const FS = 1_024_000;
const BAND_CENTER = 100_000_000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

/** Interleaved complex IQ with one or more tones at baseband offsets (Hz). */
function makeTones(n: number, offsets: number[]): Float32Array {
  const out = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const t = k / FS;
    let i = 0;
    let q = 0;
    for (const off of offsets) {
      i += Math.cos(2 * Math.PI * off * t);
      q += Math.sin(2 * Math.PI * off * t);
    }
    out[2 * k] = i / offsets.length;
    out[2 * k + 1] = q / offsets.length;
  }
  return out;
}

type Frame = { centerHz: number; sampleRate: number; bins: Float32Array };

/** Absolute frequency at fftshifted bin j. */
function binToHz(f: Frame, j: number): number {
  return (
    f.centerHz - f.sampleRate / 2 + ((j + 0.5) * f.sampleRate) / f.bins.length
  );
}
function hzToBin(f: Frame, hz: number): number {
  const frac = (hz - (f.centerHz - f.sampleRate / 2)) / f.sampleRate;
  return Math.round(frac * f.bins.length - 0.5);
}

function runZoom(
  view: { centerHz: number; spanHz: number },
  toneOffsets: number[],
): Frame | null {
  const z = new ZoomSpectrum();
  if (!z.configure(FS, BAND_CENTER, view, 0)) return null;
  const iq = makeTones(131072, toneOffsets);
  z.push(iq);
  return z.getFrame();
}

// --- 1. Resolution: two tones 1.5 kHz apart resolve as two peaks ------------
{
  // Window 40 kHz wide around +50 kHz -> ÷16 -> 64 kHz out, RBW ~31 Hz.
  // (Full band RBW is 500 Hz, so 1.5 kHz is only ~3 bins there.)
  const view = { centerHz: BAND_CENTER + 50_000, spanHz: 40_000 };
  const f = runZoom(view, [50_000, 51_500]);
  check("zoom frame produced", f != null);
  if (f) {
    check("zoom narrowed the span", f.sampleRate < FS, `${f.sampleRate} Hz`);
    let max = -Infinity;
    for (const v of f.bins) if (v > max) max = v;
    const strong = (hz: number) => {
      const j = hzToBin(f, hz);
      let best = -Infinity;
      for (let d = -2; d <= 2; d++) {
        const v = f.bins[j + d];
        if (v != null && v > best) best = v;
      }
      return best > max - 6; // within 6 dB of the global peak
    };
    check("tone at +50.0 kHz resolved", strong(BAND_CENTER + 50_000));
    check("tone at +51.5 kHz resolved", strong(BAND_CENTER + 51_500));
  }
}

// --- 2. Peak lands at the right absolute frequency --------------------------
{
  const view = { centerHz: BAND_CENTER - 120_000, spanHz: 30_000 };
  const f = runZoom(view, [-120_000]);
  check("offset-window frame produced", f != null);
  if (f) {
    let peak = 0;
    let peakV = -Infinity;
    for (let j = 0; j < f.bins.length; j++) {
      if (f.bins[j]! > peakV) {
        peakV = f.bins[j]!;
        peak = j;
      }
    }
    const hz = binToHz(f, peak);
    const rbw = f.sampleRate / f.bins.length;
    check(
      "peak within 2·RBW of the tone",
      Math.abs(hz - (BAND_CENTER - 120_000)) <= 2 * rbw,
      `${(hz - BAND_CENTER).toFixed(0)} Hz off-centre, RBW ${rbw.toFixed(1)}`,
    );
  }
}

// --- 3. Window clamps to stay inside the captured band ----------------------
{
  // Centre requested beyond the band edge; the output window must clamp.
  const view = { centerHz: BAND_CENTER + 600_000, spanHz: 40_000 };
  const f = runZoom(view, [480_000]);
  check("clamped frame produced", f != null);
  if (f) {
    const lowEdge = f.centerHz - f.sampleRate / 2;
    const highEdge = f.centerHz + f.sampleRate / 2;
    check(
      "window stays within the band",
      lowEdge >= BAND_CENTER - FS / 2 - 1 &&
        highEdge <= BAND_CENTER + FS / 2 + 1,
      `[${(lowEdge - BAND_CENTER).toFixed(0)}, ${(highEdge - BAND_CENTER).toFixed(0)}]`,
    );
  }
}

// --- 4. A near-full span is not worth zooming -------------------------------
{
  const z = new ZoomSpectrum();
  const active = z.configure(
    FS,
    BAND_CENTER,
    { centerHz: BAND_CENTER, spanHz: FS * 0.8 },
    0,
  );
  check("<2× zoom stays inactive", !active && !z.isActive);
}

// --- 5. Null view is inactive ----------------------------------------------
{
  const z = new ZoomSpectrum();
  check("null view inactive", !z.configure(FS, BAND_CENTER, null, 0));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
