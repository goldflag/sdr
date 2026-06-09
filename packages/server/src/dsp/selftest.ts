// Synthetic-signal self-test for the DSP chain. No hardware required.
// Run with: bun run src/dsp/selftest.ts  (or `bun run test:dsp`)
//
// Generates known IQ, runs it through the demodulators, and checks the recovered
// audio tone (and the spectrum peak) lands where it should.

import FFT from "fft.js";
import { AUDIO_RATE, defaultEdges } from "@sdr/shared";
import { Demodulator } from "./demod";
import { SpectrumAnalyzer } from "./fft";

const FS = 1_024_000;

function makeIq(n: number, fn: (t: number) => [number, number]): Float32Array {
  const out = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const [i, q] = fn(k / FS);
    out[2 * k] = i;
    out[2 * k + 1] = q;
  }
  return out;
}

/** Dominant frequency (Hz) of a real audio buffer via FFT peak. */
function peakHz(audio: Float32Array, rate: number): number {
  let size = 1;
  while (size * 2 <= audio.length && size < 32768) size *= 2;
  // take a steady-state window from the middle
  const start = Math.max(0, ((audio.length - size) >> 1));
  const fft = new FFT(size);
  const inp = new Float64Array(size * 2);
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    inp[2 * i] = (audio[start + i] ?? 0) * w;
  }
  const out = fft.createComplexArray();
  fft.transform(out, inp);
  let bestBin = 0;
  let bestMag = -1;
  for (let b = 1; b < size / 2; b++) {
    const re = out[2 * b]!;
    const im = out[2 * b + 1]!;
    const mag = re * re + im * im;
    if (mag > bestMag) {
      bestMag = mag;
      bestBin = b;
    }
  }
  return (bestBin * rate) / size;
}

let passed = 0;
let failed = 0;
function check(name: string, got: number, want: number, tolHz: number) {
  const ok = Math.abs(got - want) <= tolHz;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}: got ${got.toFixed(1)} Hz, want ${want} Hz (±${tolHz})`,
  );
  ok ? passed++ : failed++;
}

const N = 512_000; // 0.5 s
const TONE = 1000; // audio test tone

// 1) Spectrum: complex exponential at +100 kHz should peak at +100 kHz.
{
  const spec = new SpectrumAnalyzer(4096);
  const f = 100_000;
  spec.push(
    makeIq(8192, (t) => [Math.cos(2 * Math.PI * f * t), Math.sin(2 * Math.PI * f * t)]),
  );
  const bins = spec.getFrame()!;
  let peak = 0;
  let peakVal = -Infinity;
  for (let j = 0; j < bins.length; j++)
    if (bins[j]! > peakVal) {
      peakVal = bins[j]!;
      peak = j;
    }
  const hz = ((peak - bins.length / 2) / bins.length) * FS;
  check("spectrum peak", hz, f, FS / 4096);
}

// 2) NFM: 1 kHz tone, 3 kHz deviation.
{
  const dev = 3000;
  const beta = dev / TONE;
  const iq = makeIq(N, (t) => {
    const ph = beta * Math.sin(2 * Math.PI * TONE * t);
    return [Math.cos(ph), Math.sin(ph)];
  });
  const d = new Demodulator();
  d.configure("NFM", FS, ...defaultEdges("NFM", 12_500));
  const { audio } = d.process(iq);
  check("NFM tone", peakHz(audio, AUDIO_RATE), TONE, 60);
}

// 3) AM: 1 kHz tone, 50% modulation.
{
  const m = 0.5;
  const iq = makeIq(N, (t) => [(1 + m * Math.cos(2 * Math.PI * TONE * t)), 0]);
  const d = new Demodulator();
  d.configure("AM", FS, ...defaultEdges("AM", 10_000));
  const { audio } = d.process(iq);
  check("AM tone", peakHz(audio, AUDIO_RATE), TONE, 60);
}

// 4) USB: a baseband complex tone at +1 kHz is a USB audio tone at 1 kHz.
{
  const iq = makeIq(N, (t) => [
    Math.cos(2 * Math.PI * TONE * t),
    Math.sin(2 * Math.PI * TONE * t),
  ]);
  const d = new Demodulator();
  d.configure("USB", FS, ...defaultEdges("USB", 2_700));
  const { audio } = d.process(iq);
  check("USB tone", peakHz(audio, AUDIO_RATE), TONE, 80);
}

// 5) LSB: a baseband complex tone at -1 kHz is an LSB audio tone at 1 kHz.
{
  const iq = makeIq(N, (t) => [
    Math.cos(2 * Math.PI * TONE * t),
    -Math.sin(2 * Math.PI * TONE * t),
  ]);
  const d = new Demodulator();
  d.configure("LSB", FS, ...defaultEdges("LSB", 2_700));
  const { audio } = d.process(iq);
  check("LSB tone", peakHz(audio, AUDIO_RATE), TONE, 80);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
