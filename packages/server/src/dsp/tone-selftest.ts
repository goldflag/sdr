// Synthetic self-test for the CTCSS/DCS tone decoder. No hardware required.
// Run with: bun run src/dsp/tone-selftest.ts  (or `bun run test:tone`)
//
// The DCS alias checks are the load-bearing ones: they compare our computed
// rotation-alias table against entries of SDRangel's independently derived
// canonical-code table (dsp/dcscodes.cpp, from onfreq.com/syntorx). If our
// Golay parity matrix, signature placement, or bit order were wrong, the
// rotations would not reproduce those specific alias codes.

import { dcsCanonical, dcsEncodeWord } from "@sdr/shared";
import { Demodulator } from "./demod";
import { ToneDecoder } from "./tone";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

// Deterministic noise (no Math.random so runs are reproducible).
let seed = 1;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
}

const FS = 64_000; // NFM channel rate the decoder sees
const BLOCK = 4096;

function runDecoder(
  dec: ToneDecoder,
  seconds: number,
  gen: (t: number) => number,
) {
  const total = Math.round(seconds * FS);
  const buf = new Float32Array(BLOCK);
  for (let off = 0; off < total; off += BLOCK) {
    const n = Math.min(BLOCK, total - off);
    for (let k = 0; k < n; k++) buf[k] = gen((off + k) / FS);
    dec.process(buf, n);
  }
}

// --- 1. DCS alias table vs SDRangel's canonical-code table -----------------
{
  const expect: Array<[number, number]> = [
    [0o340, 0o023], [0o766, 0o023], [0o566, 0o026], [0o374, 0o031],
    [0o643, 0o031], [0o355, 0o043], [0o375, 0o047], [0o707, 0o047],
    [0o603, 0o071], [0o717, 0o071], [0o746, 0o071], [0o360, 0o074],
    [0o721, 0o074], [0o327, 0o114], [0o615, 0o114], [0o517, 0o156],
    [0o741, 0o156],
  ];
  let ok = 0;
  for (const [alias, canonical] of expect) {
    if (dcsCanonical(alias) === canonical) ok++;
  }
  check("DCS rotation aliases match SDRangel", ok === expect.length, `${ok}/${expect.length}`);
  check("canonical code maps to itself", dcsCanonical(0o023) === 0o023);
  check("non-code rejects", dcsCanonical(0o777) === null);
}

// --- 2. CTCSS detection ------------------------------------------------------
{
  const dec = new ToneDecoder(FS);
  // 103.5 Hz at 12% deviation under a loud 1.1 kHz "voice" tone plus noise.
  runDecoder(dec, 1.5, (t) =>
    0.12 * Math.sin(2 * Math.PI * 103.5 * t) +
    0.5 * Math.sin(2 * Math.PI * 1100 * t) +
    0.1 * rnd(),
  );
  const got = dec.detected();
  check(
    "CTCSS 103.5 detected",
    got?.kind === "ctcss" && got.hz === 103.5,
    JSON.stringify(got),
  );
  check("matches the right tone", dec.matches({ kind: "ctcss", hz: 103.5 }));
  check("rejects a different tone", !dec.matches({ kind: "ctcss", hz: 100.0 }));
}

// --- 3. CTCSS neighbour discrimination (159.8 vs 162.2, 2.4 Hz apart) -------
{
  const dec = new ToneDecoder(FS);
  runDecoder(dec, 1.5, (t) => 0.12 * Math.sin(2 * Math.PI * 159.8 * t));
  const got = dec.detected();
  check(
    "CTCSS 159.8 not confused with 162.2",
    got?.kind === "ctcss" && got.hz === 159.8,
    JSON.stringify(got),
  );
}

// --- 4. No CTCSS on open-squelch FM noise -----------------------------------
{
  const dec = new ToneDecoder(FS);
  runDecoder(dec, 1.5, () => 0.8 * rnd());
  check("noise yields no tone", dec.detected() === null);
}

// --- 5. DCS detection, both polarities ---------------------------------------
{
  const word = dcsEncodeWord(0o023);
  const dcsLevel = (t: number) => {
    const bit = Math.floor(t * 134.4) % 23;
    return (word >> bit) & 1 ? 0.1 : -0.1;
  };

  const dec = new ToneDecoder(FS);
  runDecoder(dec, 2, (t) => dcsLevel(t) + 0.02 * rnd());
  const got = dec.detected();
  check(
    "DCS D023N detected",
    got?.kind === "dcs" && got.code === 0o023 && !got.inverted,
    JSON.stringify(got),
  );
  check("matches D023N", dec.matches({ kind: "dcs", code: 0o023, inverted: false }));
  check("rejects D023I", !dec.matches({ kind: "dcs", code: 0o023, inverted: true }));
  check("rejects other code", !dec.matches({ kind: "dcs", code: 0o054, inverted: false }));

  const inv = new ToneDecoder(FS);
  runDecoder(inv, 2, (t) => -dcsLevel(t) + 0.02 * rnd());
  check(
    "inverted stream matches D023I",
    inv.matches({ kind: "dcs", code: 0o023, inverted: true }),
  );
}

// --- 6. End to end: tone decoder fed from the NFM demodulator ----------------
{
  const fs = 1_024_000;
  const demod = new Demodulator();
  demod.configure("NFM", fs, -6_250, 6_250);
  // FM-modulate 103.5 Hz CTCSS (600 Hz dev) + 1 kHz voice (2.5 kHz dev).
  let phase = 0;
  const seconds = 1.5;
  const block = 65_536;
  const iq = new Float32Array(block * 2);
  const total = Math.round(seconds * fs);
  let detected = false;
  for (let off = 0; off < total; off += block) {
    const n = Math.min(block, total - off);
    for (let k = 0; k < n; k++) {
      const t = (off + k) / fs;
      const m =
        600 * Math.sin(2 * Math.PI * 103.5 * t) +
        2_500 * Math.sin(2 * Math.PI * 1_000 * t);
      phase += (2 * Math.PI * m) / fs;
      iq[2 * k] = Math.cos(phase);
      iq[2 * k + 1] = Math.sin(phase);
    }
    demod.process(iq.subarray(0, n * 2));
    const tone = demod.detectedTone();
    if (tone?.kind === "ctcss" && tone.hz === 103.5) detected = true;
  }
  check("demod chain reports CTCSS 103.5", detected);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
