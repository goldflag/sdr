// Self-test for the RDS decoder. Synthesises a broadcast-FM multiplex (MPX)
// carrying a valid RDS bitstream — PI 0x54C4 ("WABC"), a Programme Service name,
// RadioText, and a clock-time — modulated the real way (differential + bi-phase
// on a 57 kHz subcarrier), then runs it through the real RdsDecoder and asserts
// the recovered station fields.
//
//   bun run packages/server/src/dsp/rds-selftest.ts

import { RdsDecoder } from "./rds";

const FS = 256_000; // WFM channel rate (matches a 1.024 MSPS capture)
const BIT_RATE = 1_187.5;
const SUBCARRIER = 57_000;
const POLY = 0x5b9;
const OFFSET = { A: 0x0fc, B: 0x198, C: 0x168, D: 0x1b4 };

// --- block encoder (mirror of the decoder's syndrome maths) -----------------

function remainder(value: number): number {
  let reg = value;
  for (let i = 25; i >= 10; i--) if ((reg >> i) & 1) reg ^= POLY << (i - 10);
  return reg & 0x3ff;
}
/** Build a 26-bit block: 16 info bits + (CRC ^ offset) check bits. */
function block(info: number, offset: number): number {
  const check = remainder(info << 10) ^ offset;
  return ((info << 10) | check) >>> 0;
}

const ch = (s: string, i: number) => s.charCodeAt(i) & 0xff;

// --- group builders ---------------------------------------------------------

const PI = 0x54c4; // → call sign "WABC"
const PTY = 10; // Country (RBDS)
const PS = "WABC FM "; // 8 chars
const RT = "Now Testing RDS"; // 15 chars, then a 0x0D terminator

/** A group is four 26-bit blocks. */
function group0A(seg: number): number[] {
  const ms = 1; // music
  const di = seg === 0 ? 1 : 0; // stereo flag carried in segment 0
  const typeBits = (0 << 4) | (ms << 3) | (di << 2) | seg; // ta=0
  const b = (0 << 12) | (PTY << 5) | typeBits; // group 0A
  const c = (120 << 8) | 136; // AF codes → 99.5 MHz, 101.1 MHz
  const d = (ch(PS, seg * 2) << 8) | ch(PS, seg * 2 + 1);
  return [block(PI, OFFSET.A), block(b, OFFSET.B), block(c, OFFSET.C), block(d, OFFSET.D)];
}

function group2A(seg: number): number[] {
  const b = (2 << 12) | (PTY << 5) | seg; // group 2A, text A/B = 0
  const rt = RT + "\r"; // 0x0D terminator at index 15
  const cc = (rtChar(rt, seg * 4) << 8) | rtChar(rt, seg * 4 + 1);
  const dd = (rtChar(rt, seg * 4 + 2) << 8) | rtChar(rt, seg * 4 + 3);
  return [block(PI, OFFSET.A), block(b, OFFSET.B), block(cc, OFFSET.C), block(dd, OFFSET.D)];
}
const rtChar = (s: string, i: number) => (i < s.length ? s.charCodeAt(i) & 0xff : 0x20);

function group4A(): number[] {
  const mjd = 61200; // 2026-06-09
  const hour = 14;
  const minute = 30;
  const sign = 1; // negative offset
  const offset = 10; // 10 half-hours = −5 h  → local 09:30
  const b = (4 << 12) | (PTY << 5) | ((mjd >> 15) & 0x3);
  const c = ((mjd & 0x7fff) << 1) | ((hour >> 4) & 1);
  const d = ((hour & 0xf) << 12) | ((minute & 0x3f) << 6) | (sign << 5) | (offset & 0x1f);
  return [block(PI, OFFSET.A), block(b, OFFSET.B), block(c, OFFSET.C), block(d, OFFSET.D)];
}

// --- assemble the bitstream --------------------------------------------------

const sequence: number[][] = [
  group0A(0), group2A(0), group0A(1), group2A(1),
  group0A(2), group2A(2), group0A(3), group2A(3),
  group4A(),
];
const msgBits: number[] = [];
for (let rep = 0; rep < 4; rep++) {
  for (const g of sequence) {
    for (const blk of g) {
      for (let i = 25; i >= 0; i--) msgBits.push((blk >> i) & 1);
    }
  }
}

// Differential encode: T[i] = T[i-1] XOR msg[i].
const tx: number[] = [];
let prev = 0;
for (const m of msgBits) {
  prev ^= m;
  tx.push(prev);
}

// --- modulate the MPX --------------------------------------------------------

const nsym = tx.length;
// A short tail (just enough to flush the decimator/matched filter); real RDS is
// continuous, so we don't pad with silence that would inflate the error EMA.
const totalSamples = Math.ceil((nsym / BIT_RATE) * FS) + FS / 100;
const mpx = new Float32Array(totalSamples);
const PHASE_OFFSET = 0.6; // a fixed carrier phase the Costas loop must recover
for (let n = 0; n < totalSamples; n++) {
  const t = n / FS;
  const k = Math.floor(t * BIT_RATE);
  let rds = 0;
  if (k < nsym) {
    const frac = t * BIT_RATE - k;
    const half = frac < 0.5 ? 1 : -1; // bi-phase: +half then −half
    const s = (tx[k] ? 1 : -1) * half;
    rds = 0.09 * s * Math.cos(2 * Math.PI * SUBCARRIER * t + PHASE_OFFSET);
  }
  const pilot = 0.08 * Math.cos(2 * Math.PI * 19_000 * t);
  const audio = 0.3 * Math.cos(2 * Math.PI * 1_000 * t); // L+R mono programme
  const noise = ((n % 11) - 5) * 1e-4;
  mpx[n] = audio + pilot + rds + noise;
}

// --- run + assert ------------------------------------------------------------

const rx = new RdsDecoder(FS);
// Feed in realistic block sizes (the demod hands the MPX over in chunks).
const CHUNK = 8192;
for (let off = 0; off < mpx.length; off += CHUNK) {
  const end = Math.min(off + CHUNK, mpx.length);
  rx.process(mpx.subarray(off, end), end - off);
}
const st = rx.snapshot();
const stats = rx.stats();

let pass = true;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

console.log(
  `\n[RDS] ${stats.groups} groups, BER ${(stats.blockErrorRate * 100).toFixed(1)}%, synced=${stats.synced}`,
);
console.log(`  station: ${JSON.stringify(st)}\n`);

check("station decoded", !!st, st);
check("PI = 54C4", st?.pi === "54C4", st?.pi);
check("call sign = WABC", st?.callSign === "WABC", st?.callSign);
check("PS = 'WABC FM'", st?.ps === "WABC FM", st?.ps);
check("RadioText = 'Now Testing RDS'", st?.radioText === "Now Testing RDS", st?.radioText);
check("PTY = 10 (Country)", st?.pty === 10 && st?.ptyName === "Country", [st?.pty, st?.ptyName]);
check("music flag set", st?.music === true, st?.music);
check("stereo flag set", st?.stereo === true, st?.stereo);
check("AF includes 99.5 & 101.1", !!st?.altFreqs?.includes(99.5) && !!st?.altFreqs?.includes(101.1), st?.altFreqs);
check("clock decoded", !!st?.clock, st?.clock);
if (st?.clock) {
  const d = new Date(st.clock.epoch);
  check(
    "clock = 2026-06-09 14:30 UTC",
    d.getUTCFullYear() === 2026 &&
      d.getUTCMonth() === 5 &&
      d.getUTCDate() === 9 &&
      d.getUTCHours() === 14 &&
      d.getUTCMinutes() === 30,
    st.clock.iso,
  );
  check("local offset −05:00", st.clock.iso.endsWith("-05:00"), st.clock.iso);
}
check("groups decoded (≥20)", stats.groups >= 20, stats.groups);
check("holds block sync", stats.synced, stats.synced);
check("block error rate < 15%", stats.blockErrorRate < 0.15, stats.blockErrorRate);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
