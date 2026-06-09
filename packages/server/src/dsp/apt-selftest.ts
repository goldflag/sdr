// Self-test for the NOAA APT decoder. Synthesizes a fake satellite pass — a test
// raster with the real Channel-A sync burst at each line start and a bright
// marker block at a known column — by running the receiver's pipeline in reverse
// (video -> 2400 Hz AM subcarrier -> FM -> 249.6 kSPS IQ, offset onto the IF),
// then feeds it through the real AptReceiver and asserts that it locks sync,
// renders ~every line, and that the marker lands back at its original column
// (i.e. the line alignment + AM/FM demodulation are correct).
//
//   bun run packages/server/src/dsp/apt-selftest.ts

import { APT_SAMPLE_RATE, APT_IF_OFFSET, APT_PIXELS } from "@sdr/shared";
import { AptReceiver, type AptLine } from "./apt";

const TWO_PI = 2 * Math.PI;
const AUDIO_RATE = APT_SAMPLE_RATE / 6; // 41_600
const SUBCARRIER = 2400;
const DEV = 16_000; // FM peak deviation (Hz)
const LINE = APT_PIXELS; // 2080
const SYNC_LEN = 28; // 7 cycles of 1040 Hz @ 4160 px/s
const NLINES = 200;
const MARKER_LO = 500;
const MARKER_HI = 520;

function videoPixel(x: number): number {
  if (x < SYNC_LEN) return x % 4 < 2 ? 0.95 : 0.05; // Channel-A sync burst
  if (x >= MARKER_LO && x < MARKER_HI) return 0.95; // bright alignment marker
  return 0.32 + 0.1 * Math.sin(x / 120); // faint image-like background
}

const lines: AptLine[] = [];
const rx = new AptReceiver((l) => lines.push(l));

// Stream the pass one line at a time so we never hold the whole IQ run in memory.
let fmPhase = 0;
for (let ln = 0; ln < NLINES; ln++) {
  const iq = new Float32Array(LINE * 10 * 6 * 2); // ×10 audio ×6 IF, interleaved
  let o = 0;
  for (let x = 0; x < LINE; x++) {
    const v = videoPixel(x);
    for (let u = 0; u < 10; u++) {
      const audioIdx = (ln * LINE + x) * 10 + u; // continuous subcarrier phase
      const a = v * Math.cos((TWO_PI * SUBCARRIER * audioIdx) / AUDIO_RATE);
      for (let w = 0; w < 6; w++) {
        fmPhase += (TWO_PI * (APT_IF_OFFSET + DEV * a)) / APT_SAMPLE_RATE;
        iq[o++] = Math.cos(fmPhase);
        iq[o++] = Math.sin(fmPhase);
      }
    }
  }
  rx.process(iq);
}

// Brightest column in the video region (skip the equally-bright sync burst).
function argmax(px: Uint8Array): number {
  let bi = 100;
  let bv = -1;
  for (let i = 100; i < px.length; i++)
    if (px[i]! > bv) {
      bv = px[i]!;
      bi = i;
    }
  return bi;
}

// Average the marker column over a band of mid-pass lines (skip lock-in start).
const mid = lines.slice(50, 150);
const markerCols = mid.map((l) => argmax(l.pixels));
const avgMarker =
  markerCols.reduce((s, c) => s + c, 0) / Math.max(markerCols.length, 1);
const avgSync = mid.reduce((s, l) => s + l.sync, 0) / Math.max(mid.length, 1);

let pass = true;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

console.log(
  `\n${lines.length} lines, sync≈${rx.syncLevel}, level ${rx.levelDb} dB, ` +
    `marker col≈${avgMarker.toFixed(1)}\n`,
);

check("rendered most lines (≥180)", lines.length >= 180, lines.length);
check("locked sync (avg > 0.5)", avgSync > 0.5, avgSync);
check("final sync level high", rx.syncLevel > 0.5, rx.syncLevel);
check(
  `marker aligned near col ${MARKER_LO} (±25)`,
  avgMarker >= MARKER_LO - 25 && avgMarker <= MARKER_HI + 25,
  avgMarker,
);
// Every mid line should agree on the marker column (stable alignment).
const spread = Math.max(...markerCols) - Math.min(...markerCols);
check("alignment stable across lines (spread ≤ 8)", spread <= 8, spread);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
