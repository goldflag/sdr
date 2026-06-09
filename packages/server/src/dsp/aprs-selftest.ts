// Self-test for the APRS decoder. Builds a real AX.25 UI frame (addresses +
// control/PID + info), HDLC-frames it (flags, NRZI, bit-stuffing, X.25 FCS),
// Bell-202 AFSK-modulates it (1200/2200 Hz tones), FM-modulates that onto a
// carrier at the receiver's IF offset, and runs the resulting 240 kSPS IQ
// through the real AprsReceiver — asserting the decoded callsign and position.
//
//   bun run packages/server/src/dsp/aprs-selftest.ts
//
// The payload is the canonical aprs-python MIC-E example (dest "SUSUR1"),
// which decodes to 35.5868°N, 139.701°E, course 305°, altitude 8 m.

import { APRS_SAMPLE_RATE, APRS_IF_OFFSET } from "@sdr/shared";
import { AprsReceiver, parseAx25, parseMicE } from "./aprs";

const BAUD = 1200;

// --- AX.25 frame assembly --------------------------------------------------

function addr(call: string, ssid: number, last: boolean): number[] {
  const out: number[] = [];
  const padded = (call + "      ").slice(0, 6);
  for (let i = 0; i < 6; i++) out.push(padded.charCodeAt(i) << 1);
  out.push(0x60 | ((ssid & 0x0f) << 1) | (last ? 1 : 0));
  return out;
}

function buildFrame(): Uint8Array {
  const info = "`CF\"l#![/`\"3z}_ "; // MIC-E body for SUSUR1
  const bytes = [
    ...addr("SUSUR1", 0, false), // destination (encodes latitude)
    ...addr("TEST", 9, true), // source TEST-9, last address
    0x03, // UI control
    0xf0, // no layer-3 PID
  ];
  for (let i = 0; i < info.length; i++) bytes.push(info.charCodeAt(i));
  return new Uint8Array(bytes);
}

// --- AX.25 bytes -> on-air NRZI symbol levels ------------------------------

function buildLevels(frame: Uint8Array): number[] {
  // Data bits in transmission order (each octet LSB first).
  const data: number[] = [];
  for (let g = 0; g < frame.length; g++)
    for (let k = 0; k < 8; k++) data.push((frame[g]! >> k) & 1);

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

  // Flag (0x7E) LSB first; pad generously with leading/trailing flags.
  const flag = [0, 1, 1, 1, 1, 1, 1, 0];
  const bits: number[] = [];
  for (let i = 0; i < 32; i++) bits.push(...flag);
  bits.push(...stuffed);
  for (let i = 0; i < 8; i++) bits.push(...flag);

  // NRZI encode: bit 1 keeps the level, bit 0 toggles it.
  const levels: number[] = [];
  let level = 1;
  for (const b of bits) {
    if (b === 0) level ^= 1;
    levels.push(level);
  }
  return levels;
}

// --- NRZI levels -> AFSK audio -> FM IQ ------------------------------------

function synthIq(levels: number[]): Float32Array {
  const fs = APRS_SAMPLE_RATE;
  const sps = fs / BAUD; // 200 IQ samples per symbol
  const dev = 3000; // FM deviation
  const guard = 400;
  const total = guard * 2 + levels.length * sps;
  const iq = new Float32Array(total * 2);
  let audioPhase = 0;
  let carrierPhase = 0;
  let o = guard * 2;
  // Leading silence (still advance the carrier so the NCO/discriminator settle).
  for (let s = 0; s < guard; s++) {
    carrierPhase += (2 * Math.PI * APRS_IF_OFFSET) / fs;
  }
  for (const lvl of levels) {
    const tone = lvl ? 1200 : 2200; // mark / space
    for (let s = 0; s < sps; s++) {
      audioPhase += (2 * Math.PI * tone) / fs;
      const audio = Math.sin(audioPhase);
      carrierPhase += (2 * Math.PI * (APRS_IF_OFFSET + dev * audio)) / fs;
      iq[o++] = Math.cos(carrierPhase);
      iq[o++] = Math.sin(carrierPhase);
    }
  }
  return iq;
}

// --- run -------------------------------------------------------------------

let pass = true;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

// First, a pure-software check of the AX.25 + MIC-E parsers (no DSP).
const frame = buildFrame();
const ax = parseAx25(frame);
check("AX.25 parses", !!ax, ax);
check("source = TEST-9", ax?.source === "TEST-9", ax?.source);
const mic = ax ? parseMicE(ax.destChars, ax.info) : null;
check("MIC-E lat ≈ 35.5868", mic?.lat != null && Math.abs(mic.lat - 35.5868) < 0.001, mic?.lat);
check("MIC-E lon ≈ 139.701", mic?.lon != null && Math.abs(mic.lon - 139.701) < 0.001, mic?.lon);
check("MIC-E course = 305", mic?.course === 305, mic?.course);
check("MIC-E altitude ≈ 26 ft", mic?.altitude != null && Math.abs(mic.altitude - 26) <= 1, mic?.altitude);

// Then the full RF chain through the real receiver.
const iq = synthIq(buildLevels(frame));
const rx = new AprsReceiver();
rx.process(iq);
const stations = rx.snapshot(Date.now());
console.log(`\ndecoded ${rx.totalMessages} packets, ${stations.length} stations\n`);

const st = stations.find((s) => s.call === "TEST-9");
check("packet decoded through AFSK", stations.length > 0, stations);
check("station = TEST-9", !!st, stations.map((s) => s.call));
check("position present", st?.lat != null && st?.lon != null, st && [st?.lat, st?.lon]);
check("latitude ≈ 35.5868", st?.lat != null && Math.abs(st.lat - 35.5868) < 0.001, st?.lat);
check("longitude ≈ 139.701", st?.lon != null && Math.abs(st.lon - 139.701) < 0.001, st?.lon);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
