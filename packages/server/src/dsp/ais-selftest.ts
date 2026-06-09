// Self-test for the AIS decoder: synthesizes a clean 240 kSPS GMSK waveform for
// a known AIVDM message (HDLC framing + bit-stuffing + NRZI + MSK modulation on
// channel A) and runs it through the real AisReceiver, asserting the decoded
// MMSI / type / position.
//
//   bun run packages/server/src/dsp/ais-selftest.ts
//
// Test vector is the canonical catb.org AIVDM/AIVDO example (type 1).

import { AIS_SAMPLE_RATE, AIS_CHANNELS } from "@sdr/shared";
import { AisReceiver } from "./ais";

// --- AIVDM armor -> logical message bytes (MSB first) ----------------------

function aivdmToBytes(payload: string): Uint8Array {
  const bits: number[] = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    for (let k = 5; k >= 0; k--) bits.push((v >> k) & 1); // 6 bits, MSB first
  }
  const nbytes = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(nbytes);
  for (let i = 0; i < nbytes * 8; i++)
    if (bits[i]) bytes[i >> 3]! |= 1 << (7 - (i & 7));
  return bytes;
}

// --- logical bytes -> on-air NRZI symbol levels ----------------------------

function buildLevels(bytes: Uint8Array): number[] {
  // Data bits in transmission order (each octet LSB first).
  const data: number[] = [];
  for (let g = 0; g < bytes.length; g++)
    for (let k = 0; k < 8; k++) data.push((bytes[g]! >> k) & 1);

  // CRC-16/X.25 FCS (reflected), appended LSB first.
  let crc = 0xffff;
  for (const b of data) {
    const x = (b ^ (crc & 1)) & 1;
    crc >>>= 1;
    if (x) crc ^= 0x8408;
  }
  crc = (crc ^ 0xffff) & 0xffff;
  const fcs: number[] = [];
  for (let i = 0; i < 16; i++) fcs.push((crc >> i) & 1);

  // Bit-stuff data+FCS (insert a 0 after five consecutive 1s).
  const stuffed: number[] = [];
  let ones = 0;
  for (const b of [...data, ...fcs]) {
    stuffed.push(b);
    if (b === 1) {
      if (++ones === 5) {
        stuffed.push(0);
        ones = 0;
      }
    } else ones = 0;
  }

  // 24-bit training preamble (alternating) + flag + frame + flag.
  const flag = [0, 1, 1, 1, 1, 1, 1, 0];
  const training: number[] = [];
  for (let i = 0; i < 24; i++) training.push(i & 1);
  const allBits = [...training, ...flag, ...stuffed, ...flag];

  // NRZI encode: bit 1 keeps the level, bit 0 toggles it.
  const levels: number[] = [];
  let level = 1;
  for (const b of allBits) {
    if (b === 0) level ^= 1;
    levels.push(level);
  }
  return levels;
}

// --- NRZI levels -> MSK IQ on channel A ------------------------------------

function synthIq(levels: number[]): Float32Array {
  const fs = AIS_SAMPLE_RATE;
  const sps = fs / 9600; // 25 samples per symbol at 240 kSPS
  const dev = 2400; // MSK deviation = baud/4
  const offset = AIS_CHANNELS.A; // -25 kHz
  const guard = 200; // leading/trailing silence (complex samples)
  const total = guard * 2 + levels.length * sps;
  const iq = new Float32Array(total * 2);
  let phase = 0;
  let o = guard * 2;
  for (const lvl of levels) {
    const f = offset + (lvl ? dev : -dev);
    const dphi = (2 * Math.PI * f) / fs;
    for (let s = 0; s < sps; s++) {
      phase += dphi;
      iq[o++] = Math.cos(phase);
      iq[o++] = Math.sin(phase);
    }
  }
  return iq;
}

// --- run -------------------------------------------------------------------

const PAYLOAD = "177KQJ5000G?tO`K>RA1wUbN0TKH"; // catb.org example, MMSI 477553000
const bytes = aivdmToBytes(PAYLOAD);
const iq = synthIq(buildLevels(bytes));

const rx = new AisReceiver();
rx.process(iq);
const vessels = rx.snapshot(Date.now());

let pass = true;
function check(name: string, ok: boolean, got: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

console.log(`decoded ${rx.totalMessages} messages, ${vessels.length} vessels\n`);

const v = vessels.find((x) => x.mmsi === "477553000");
check("message decoded", vessels.length > 0, vessels);
check("MMSI = 477553000", !!v, vessels.map((x) => x.mmsi));
check("position present", v?.lat != null && v?.lon != null, v && [v.lat, v.lon]);
// catb.org example decodes to 47.582833°N, 122.345833°W (Puget Sound).
check(
  "latitude ≈ 47.5828",
  v?.lat != null && Math.abs(v.lat - 47.5828) < 0.01,
  v?.lat,
);
check(
  "longitude ≈ -122.3458",
  v?.lon != null && Math.abs(v.lon - -122.3458) < 0.01,
  v?.lon,
);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
