// Self-test for the ADS-B decoder: synthesizes the 2 MSPS IQ waveform (preamble
// + Manchester PPM) for known-good Mode S frames and runs them through the real
// AdsbReceiver, asserting the decoded callsign / position / velocity.
//
//   bun run packages/server/src/dsp/adsb-selftest.ts
//
// Test vectors are the canonical pyModeS examples.

import { AdsbReceiver } from "./adsb";

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

// Build the 240-sample (480-float) IQ waveform for one 112-bit frame.
// Preamble pulses at samples 0,2,7,9; each data bit is 2 samples (PPM).
function synth(msg: Uint8Array): Float32Array {
  const samples = new Float32Array(240); // magnitude per sample, 1 = pulse
  for (const p of [0, 2, 7, 9]) samples[p] = 1;
  for (let bit = 0; bit < 112; bit++) {
    const v = (msg[bit >> 3]! >> (7 - (bit & 7))) & 1;
    const base = 16 + bit * 2;
    if (v) samples[base] = 1; // 1 → high then low
    else samples[base + 1] = 1; // 0 → low then high
  }
  // Expand to interleaved IQ (put magnitude on I, Q = 0).
  const iq = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) iq[i * 2] = samples[i]!;
  return iq;
}

const FRAMES = [
  "8D4840D6202CC371C32CE0576098", // ident: KLM1023, ICAO 4840D6
  // Position pair fed odd-then-even so the even frame is the latest reference,
  // matching the canonical pyModeS result (52.2572, 3.91937).
  "8D40621D58C386435CC412692AD6", // position odd, ICAO 40621D
  "8D40621D58C382D690C8AC2863A7", // position even, ICAO 40621D
  "8D485020994409940838175B284F", // velocity, ICAO 485020
];

// One contiguous buffer with silence gaps so nothing is reprocessed via carry.
const GAP = 64;
const parts: Float32Array[] = [];
for (const hex of FRAMES) {
  parts.push(new Float32Array(GAP * 2));
  parts.push(synth(hexToBytes(hex)));
}
parts.push(new Float32Array(GAP * 2));
const total = parts.reduce((n, p) => n + p.length, 0);
const iq = new Float32Array(total);
let off = 0;
for (const p of parts) {
  iq.set(p, off);
  off += p.length;
}

const rx = new AdsbReceiver();
rx.process(iq);
const list = rx.snapshot(Date.now());

let pass = true;
function check(name: string, ok: boolean, got: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

console.log(`decoded ${rx.totalMessages} frames, ${list.length} aircraft\n`);

const klm = list.find((a) => a.icao === "4840d6");
check("ident frame decoded", !!klm, klm);
check("callsign = KLM1023", klm?.callsign === "KLM1023", klm?.callsign);

const pos = list.find((a) => a.icao === "40621d");
check("position frame decoded", !!pos, pos);
check(
  "latitude ≈ 52.2572",
  pos?.lat != null && Math.abs(pos.lat - 52.2572) < 0.001,
  pos?.lat,
);
check(
  "longitude ≈ 3.91937",
  pos?.lon != null && Math.abs(pos.lon - 3.91937) < 0.001,
  pos?.lon,
);

const vel = list.find((a) => a.icao === "485020");
check("velocity frame decoded", !!vel, vel);
check(
  "ground speed ≈ 159 kt",
  vel?.speed != null && Math.abs(vel.speed - 159) <= 1,
  vel?.speed,
);
check(
  "track ≈ 183°",
  vel?.heading != null && Math.abs(vel.heading - 183) <= 1,
  vel?.heading,
);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
