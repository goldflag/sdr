// Self-test for the ISM OOK decoder. Synthesizes three real OOK transmissions —
// an EV1527 fixed-code remote, an Acurite 592TXR temp/humidity sensor, and a
// LaCrosse TX141TH-Bv2 — as 250 kSPS IQ, runs each through the real IsmReceiver,
// and asserts the decoded fields (code/id, temperature, humidity) plus that the
// repeated transmissions fold into a single event.
//
//   bun run packages/server/src/dsp/ism-selftest.ts

import { ISM_SAMPLE_RATE } from "@sdr/shared";
import { IsmReceiver } from "./ism";

const CARRIER = 40_000; // off-centre so it isn't on the DC spike

function pushTone(iq: number[], durUs: number, on: boolean, phase: { p: number }) {
  const samples = Math.round((durUs * ISM_SAMPLE_RATE) / 1e6);
  const dphi = (2 * Math.PI * CARRIER) / ISM_SAMPLE_RATE;
  for (let s = 0; s < samples; s++) {
    phase.p += dphi;
    if (on) {
      iq.push(Math.cos(phase.p), Math.sin(phase.p));
    } else {
      // Idle: a touch of noise so the floor estimate has something to track.
      iq.push((s % 7) * 1e-4 - 3e-4, (s % 5) * 1e-4 - 2e-4);
    }
  }
}

// PWM bit: '1' = long mark + short space, '0' = short mark + long space.
interface Pwm {
  shortMark: number;
  longMark: number;
  shortSpace: number;
  longSpace: number;
}
function pushBit(iq: number[], one: boolean, phase: { p: number }, t: Pwm) {
  pushTone(iq, one ? t.longMark : t.shortMark, true, phase);
  pushTone(iq, one ? t.shortSpace : t.longSpace, false, phase);
}
function pushBytes(
  iq: number[],
  bytes: number[],
  nbits: number,
  phase: { p: number },
  t: Pwm,
) {
  for (let i = 0; i < nbits; i++) {
    const byte = bytes[i >> 3]!;
    const bit = (byte >> (7 - (i & 7))) & 1; // MSB-first
    pushBit(iq, bit === 1, phase, t);
  }
}

// --- encoders (build valid frames the documented way) ----------------------

function parity8(v: number): number {
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return v & 1;
}
const withParity = (v7: number) => (v7 & 0x7f) | (parity8(v7 & 0x7f) << 7);

function lfsrDigest8Reflect(msg: number[], bytes: number, gen: number, key: number) {
  let sum = 0;
  for (let k = bytes - 1; k >= 0; k--) {
    const data = msg[k]!;
    for (let i = 0; i < 8; i++) {
      if ((data >> i) & 1) sum ^= key;
      key = key & 1 ? (key >> 1) ^ gen : key >> 1;
    }
  }
  return sum & 0xff;
}

function encodeAcurite(
  id: number,
  channel: number, // 3=A,2=B,0=C
  tempC: number,
  humidity: number,
  batteryOk: boolean,
): number[] {
  const tempRaw = Math.round(tempC * 10) + 1000;
  const b0 = ((channel & 0x3) << 6) | ((id >> 8) & 0x3f);
  const b1 = id & 0xff;
  const b2 = withParity((batteryOk ? 0x40 : 0) | 0x04); // battery + message type
  const b3 = withParity(humidity & 0x7f);
  const b4 = withParity((tempRaw >> 7) & 0x7f);
  const b5 = withParity(tempRaw & 0x7f);
  const b6 = (b0 + b1 + b2 + b3 + b4 + b5) & 0xff;
  return [b0, b1, b2, b3, b4, b5, b6];
}

function encodeLaCrosse(
  id: number,
  channel: number,
  tempC: number,
  humidity: number,
  batteryLow: boolean,
): number[] {
  const tempRaw = Math.round(tempC * 10) + 500;
  const b0 = id & 0xff;
  const b1 =
    ((batteryLow ? 1 : 0) << 7) | ((channel & 0x3) << 4) | ((tempRaw >> 8) & 0x0f);
  const b2 = tempRaw & 0xff;
  const b3 = humidity & 0xff;
  const b4 = lfsrDigest8Reflect([b0, b1, b2, b3], 4, 0x31, 0xf4);
  return [b0, b1, b2, b3, b4];
}

// Forward (MSB-first) LFSR digest — the F007TH checksum (mirror of ism.ts).
function lfsrDigest8(b: number[], len: number, gen: number, key: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const data = b[i]!;
    for (let bit = 7; bit >= 0; bit--) {
      if ((data >> bit) & 1) sum ^= key;
      key = key & 0x80 ? ((key << 1) ^ gen) & 0xff : (key << 1) & 0xff;
    }
  }
  return sum & 0xff;
}

function crc16(b: number[], len: number, poly: number, init: number): number {
  let crc = init;
  for (let i = 0; i < len; i++) {
    crc ^= b[i]! << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

const reverse4 = (v: number) =>
  (((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3)) & 0xf;

function encodeAcurite5n1Temp(
  id: number,
  channel: number, // 3=A,2=B,0=C
  tempF: number,
  humidity: number,
  windRaw: number,
): number[] {
  const tempRaw = Math.round(tempF * 10) + 400;
  const b0 = ((channel & 0x3) << 6) | ((id >> 8) & 0x0f);
  const b1 = id & 0xff;
  const b2 = withParity(0x38);
  const b3 = withParity((windRaw >> 3) & 0x1f);
  const b4 = withParity(((windRaw & 0x7) << 4) | ((tempRaw >> 7) & 0x0f));
  const b5 = withParity(tempRaw & 0x7f);
  const b6 = withParity(humidity & 0x7f);
  const b7 = (b0 + b1 + b2 + b3 + b4 + b5 + b6) & 0xff;
  return [b0, b1, b2, b3, b4, b5, b6, b7];
}

function encodeAcurite5n1Rain(
  id: number,
  channel: number,
  windRaw: number,
  dirIdx: number,
  rainRaw: number,
): number[] {
  const b0 = ((channel & 0x3) << 6) | ((id >> 8) & 0x0f);
  const b1 = id & 0xff;
  const b2 = withParity(0x31);
  const b3 = withParity((windRaw >> 3) & 0x1f);
  const b4 = withParity(((windRaw & 0x7) << 4) | (dirIdx & 0x0f));
  const b5 = withParity((rainRaw >> 7) & 0x7f);
  const b6 = withParity(rainRaw & 0x7f);
  const b7 = (b0 + b1 + b2 + b3 + b4 + b5 + b6) & 0xff;
  return [b0, b1, b2, b3, b4, b5, b6, b7];
}

// Oregon v3: 24 one-bits preamble, sync nibble 0x5 (raw), then 16 data nibbles
// each sent LSB-first (reflected). Returns the bit list for the Manchester synth.
function encodeOregon(
  id: number,
  channel: number,
  tempC: number,
  humidity: number,
  batteryLow: boolean,
): number[] {
  const neg = tempC < 0;
  const a = Math.abs(tempC);
  const tens = Math.floor(a / 10) % 10;
  const units = Math.floor(a) % 10;
  const tenths = Math.round(a * 10) % 10;
  const nib = [
    (id >> 12) & 0xf, (id >> 8) & 0xf, (id >> 4) & 0xf, id & 0xf,
    channel & 0xf, 0, 0, batteryLow ? 0x4 : 0,
    tenths, units, tens, neg ? 0x8 : 0,
    humidity % 10, Math.floor(humidity / 10) % 10, 0, 0,
  ];
  let sum = 0;
  for (let k = 0; k < 14; k++) sum += nib[k]!;
  nib[14] = sum & 0x0f;
  nib[15] = (sum >> 4) & 0x0f;
  const bits: number[] = [];
  for (let k = 0; k < 24; k++) bits.push(1); // preamble
  for (const s of [0, 1, 0, 1]) bits.push(s); // sync nibble 0x5, raw
  for (const v of nib) {
    const r = reverse4(v);
    bits.push((r >> 3) & 1, (r >> 2) & 1, (r >> 1) & 1, r & 1);
  }
  return bits;
}

function encodeNexus(
  id: number,
  channel: number,
  tempC: number,
  humidity: number,
  batteryOk: boolean,
): number[] {
  const tempRaw = Math.round(tempC * 10) & 0xfff;
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  push(id, 8);
  bits.push(batteryOk ? 1 : 0);
  bits.push(0);
  push((channel - 1) & 0x3, 2);
  push(tempRaw, 12);
  push(0xf, 4);
  push(humidity, 8);
  return bits;
}

function encodeF007th(
  id: number,
  channel: number,
  tempF: number,
  humidity: number,
  batteryLow: boolean,
): number[] {
  const tempRaw = Math.round(tempF * 10) + 400;
  const b0 = 0x05;
  const b1 = id & 0xff;
  const b2 = (batteryLow ? 0x80 : 0) | (((channel - 1) & 0x07) << 4) | ((tempRaw >> 8) & 0x0f);
  const b3 = tempRaw & 0xff;
  const b4 = humidity & 0xff;
  const b5 = lfsrDigest8([b0, b1, b2, b3, b4], 5, 0x98, 0x3e) ^ 0x64;
  return [b0, b1, b2, b3, b4, b5];
}

function encodeHoneywell(channel: number, serial: number, event: number): number[] {
  const b0 = ((channel & 0xf) << 4) | ((serial >> 16) & 0x0f);
  const b1 = (serial >> 8) & 0xff;
  const b2 = serial & 0xff;
  const b3 = event & 0xff;
  const crc = crc16([b0, b1, b2, b3], 4, channel === 8 ? 0x8005 : 0x8050, 0);
  return [b0, b1, b2, b3, (crc >> 8) & 0xff, crc & 0xff];
}

// Fine Offset WH25: model 0xE, id, batt/temp, humidity, pressure, then a byte-sum
// and a nibble-swapped XOR check byte.
function encodeFineOffset(
  id: number,
  tempC: number,
  humidity: number,
  pressureHpa: number,
  batteryLow: boolean,
): number[] {
  const tempRaw = Math.round(tempC * 10) + 400;
  const p = Math.round(pressureHpa * 10);
  const b0 = 0xe0 | ((id >> 4) & 0x0f);
  const b1 = ((id & 0x0f) << 4) | ((batteryLow ? 0 : 1) << 3) | ((tempRaw >> 8) & 0x03);
  const b2 = tempRaw & 0xff;
  const b3 = humidity & 0xff;
  const b4 = (p >> 8) & 0xff;
  const b5 = p & 0xff;
  let sum = 0;
  let x = 0;
  for (const v of [b0, b1, b2, b3, b4, b5]) {
    sum = (sum + v) & 0xff;
    x ^= v;
  }
  const b7 = ((x & 0x0f) << 4) | ((x >> 4) & 0x0f);
  return [b0, b1, b2, b3, b4, b5, sum, b7];
}

// FSK synth: constant amplitude, carrier shifted between a mark and a space
// frequency per NRZ bit. Run through the real discriminator path in IsmReceiver.
const FSK_MARK = 50_000;
const FSK_SPACE = -50_000;
function pushFskBits(iq: number[], bits: number[], spb: number, phase: { p: number }) {
  for (const bit of bits) {
    const dphi = (2 * Math.PI * (bit ? FSK_MARK : FSK_SPACE)) / ISM_SAMPLE_RATE;
    for (let s = 0; s < spb; s++) {
      phase.p += dphi;
      iq.push(Math.cos(phase.p), Math.sin(phase.p));
    }
  }
}
function fskFrame(bytes: number[], nbits: number): number[] {
  const bits: number[] = [];
  for (let k = 0; k < 16; k++) bits.push(1, 0); // 0xAA… preamble
  for (const v of [0x2d, 0xd4]) for (let i = 7; i >= 0; i--) bits.push((v >> i) & 1); // sync
  for (let i = 0; i < nbits; i++) bits.push((bytes[i >> 3]! >> (7 - (i & 7))) & 1);
  return bits;
}

function crc8(b: number[], len: number, poly: number, init: number): number {
  let crc = init;
  for (let i = 0; i < len; i++) {
    crc ^= b[i]!;
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
  }
  return crc & 0xff;
}

// Differential Manchester encode (mirror of diffManchester): boundary transition
// every bit, plus a mid-bit transition iff the bit is 1.
function dmcEncode(bits: number[]): number[] {
  let L = 0;
  const chips: number[] = [];
  for (const bit of bits) {
    L ^= 1;
    chips.push(L);
    if (bit) L ^= 1;
    chips.push(L);
  }
  return chips;
}

const TOYOTA_SYNC = [1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0];
function encodeToyota(id: number, pressureKpa: number, tempC: number): number[] {
  const praw = Math.round((pressureKpa / 6.89476 + 7.0) / 0.25) & 0xff;
  const traw = (tempC + 40) & 0xff;
  const b0 = (id >>> 24) & 0xff;
  const b1 = (id >>> 16) & 0xff;
  const b2 = (id >>> 8) & 0xff;
  const b3 = id & 0xff;
  const b4 = (praw >> 1) & 0x7f;
  const b5 = ((praw & 1) << 7) | ((traw >> 1) & 0x7f);
  const b6 = (traw & 1) << 7;
  const b7 = b4 ^ 0xff;
  const b8 = crc8([b0, b1, b2, b3, b4, b5, b6, b7], 8, 0x07, 0x80);
  return [b0, b1, b2, b3, b4, b5, b6, b7, b8];
}
function toyotaChips(id: number, pressureKpa: number, tempC: number): number[] {
  const bytes = encodeToyota(id, pressureKpa, tempC);
  const bits: number[] = [];
  for (let i = 0; i < 72; i++) bits.push((bytes[i >> 3]! >> (7 - (i & 7))) & 1);
  bits.push(0, 0, 0); // 3 trailer bits (bound the final data bit), as the device sends
  const chips: number[] = [];
  for (let k = 0; k < 24; k++) chips.push((k + 1) & 1); // settle, ending on a mark
  chips.push(...TOYOTA_SYNC, ...dmcEncode(bits));
  return chips;
}

// Bytes (MSB-first) → bit list, for the Manchester synth.
function bytesToBits(bytes: number[], nbits: number, preamble = 12): number[] {
  const bits: number[] = [];
  for (let k = 0; k < preamble; k++) bits.push(1);
  for (let i = 0; i < nbits; i++) bits.push((bytes[i >> 3]! >> (7 - (i & 7))) & 1);
  return bits;
}

// Manchester synth: data bit 1 → half-bits low,high; 0 → high,low (G.E. Thomas).
// Consecutive equal half-bits merge into one tone so the envelope detector sees
// realistic 1T/2T runs. A trailing mark bounds the final bit's gap.
function pushManchester(iq: number[], bits: number[], T: number, phase: { p: number }) {
  const half: number[] = [];
  for (const bit of bits) half.push(bit ? 0 : 1, bit ? 1 : 0);
  let i = 0;
  while (i < half.length) {
    let j = i;
    while (j < half.length && half[j] === half[i]) j++;
    pushTone(iq, (j - i) * T, half[i] === 1, phase);
    i = j;
  }
  pushTone(iq, T, true, phase); // terminator mark
}

// --- synth: leading silence, N repeats with a reset gap, trailing silence ----

function synth(
  build: (iq: number[], phase: { p: number }) => void,
  reps: number,
): Float32Array {
  const iq: number[] = [];
  const phase = { p: 0 };
  pushTone(iq, 20_000, false, phase); // floor settles
  for (let r = 0; r < reps; r++) {
    build(iq, phase);
    pushTone(iq, 150, true, phase); // terminator mark: records the final bit's gap
    pushTone(iq, 5000, false, phase); // reset gap (> 3500 µs) flushes the packet
  }
  pushTone(iq, 20_000, false, phase);
  return new Float32Array(iq);
}

const EV_CODE = 0xa53c14; // 24-bit: id 0xa53c1 + data 0x4
const EV_UNIT = 300;
const evSynth = synth((iq, phase) => {
  const t: Pwm = {
    shortMark: EV_UNIT,
    longMark: 3 * EV_UNIT,
    shortSpace: EV_UNIT,
    longSpace: 3 * EV_UNIT,
  };
  for (let bit = 23; bit >= 0; bit--) pushBit(iq, ((EV_CODE >> bit) & 1) === 1, phase, t);
  pushTone(iq, EV_UNIT, true, phase); // sync pulse
}, 4);

const ACU: Pwm = { shortMark: 220, longMark: 408, shortSpace: 204, longSpace: 392 };
const acuBytes = encodeAcurite(0x1234, 3, 21.3, 45, true);
const acuSynth = synth((iq, phase) => {
  pushTone(iq, 620, true, phase); // sync pulse (≈equal mark/space → stray bit)
  pushTone(iq, 596, false, phase);
  pushBytes(iq, acuBytes, 56, phase, ACU);
}, 3);

const LAC: Pwm = { shortMark: 208, longMark: 417, shortSpace: 208, longSpace: 417 };
const lacBytes = encodeLaCrosse(0x5a, 1, 19.8, 55, false);
const lacSynth = synth((iq, phase) => {
  for (let s = 0; s < 4; s++) {
    pushTone(iq, 833, true, phase); // sync preamble (equal → stray '0' bits)
    pushTone(iq, 833, false, phase);
  }
  pushBytes(iq, lacBytes, 40, phase, LAC);
}, 3);

// Acurite 5n1 (PWM, same timing as the Tower): a temp/humidity frame (0x38) and
// a wind/direction/rain frame (0x31).
const acu5tBytes = encodeAcurite5n1Temp(0x1c5, 3, 71.5, 44, 12);
const acu5tSynth = synth((iq, phase) => {
  pushTone(iq, 620, true, phase);
  pushTone(iq, 596, false, phase);
  pushBytes(iq, acu5tBytes, 64, phase, ACU);
}, 3);
const acu5rBytes = encodeAcurite5n1Rain(0x1c5, 3, 20, 6, 100);
const acu5rSynth = synth((iq, phase) => {
  pushTone(iq, 620, true, phase);
  pushTone(iq, 596, false, phase);
  pushBytes(iq, acu5rBytes, 64, phase, ACU);
}, 3);

// Oregon v3 THGR810 (Manchester, reflected nibbles).
const oregonBits = encodeOregon(0xf824, 3, 21.3, 48, false);
const oregonSynth = synth((iq, phase) => pushManchester(iq, oregonBits, 488, phase), 3);

// Ambient F007TH (Manchester).
const f007Bytes = encodeF007th(0x9c, 2, 71.5, 50, false);
const f007Synth = synth((iq, phase) => pushManchester(iq, bytesToBits(f007Bytes, 48), 500, phase), 3);

// Honeywell door/window contact (Manchester, CRC-16), event = contact open.
const honeyBytes = encodeHoneywell(8, 0x12345, 0x80);
const honeySynth = synth((iq, phase) => pushManchester(iq, bytesToBits(honeyBytes, 48), 250, phase), 3);

// Nexus-TH (PPM): constant ~488 µs pulse, gap 976 µs = 0 / 1952 µs = 1.
const nexusBits = encodeNexus(0x5a, 2, 23.5, 60, true);
const nexusSynth = (() => {
  const iq: number[] = [];
  const phase = { p: 0 };
  pushTone(iq, 20_000, false, phase);
  for (let r = 0; r < 3; r++) {
    for (const bit of nexusBits) {
      pushTone(iq, 488, true, phase);
      pushTone(iq, bit ? 1952 : 976, false, phase);
    }
    pushTone(iq, 488, true, phase); // terminator pulse
    pushTone(iq, 5000, false, phase); // reset gap (> 3500 µs) flushes
  }
  pushTone(iq, 20_000, false, phase);
  return new Float32Array(iq);
})();

// Fine Offset WH25 (FSK/NRZ) — exercises the frequency-discriminator path.
const fineBytes = encodeFineOffset(0x4d, 23.4, 58, 1013.2, false);
const fineSynth = (() => {
  const iq: number[] = [];
  const phase = { p: 0 };
  pushTone(iq, 20_000, false, phase); // silence; floor settles
  for (let r = 0; r < 3; r++) {
    pushFskBits(iq, fskFrame(fineBytes, 64), 10, phase);
    pushTone(iq, 4000, false, phase); // inter-packet silence (> FSK reset) flushes
  }
  pushTone(iq, 20_000, false, phase);
  return new Float32Array(iq);
})();

// Toyota TPMS (FSK, differential Manchester) — exercises the FSK + DMC path.
const toyChips = toyotaChips(0x01a2b3c4, 220, 25);
const toyotaSynth = (() => {
  const iq: number[] = [];
  const phase = { p: 0 };
  pushTone(iq, 20_000, false, phase);
  for (let r = 0; r < 3; r++) {
    pushFskBits(iq, toyChips, 16, phase); // ~15.6 kchip/s — resolvable at 250 kSPS
    pushTone(iq, 4000, false, phase);
  }
  pushTone(iq, 20_000, false, phase);
  return new Float32Array(iq);
})();

// Negative controls: a checksum-corrupted Acurite frame, and band noise.
const acuBad = [...acuBytes];
acuBad[6] = (acuBad[6]! ^ 0x01) & 0xff;
const acuBadSynth = synth((iq, phase) => {
  pushTone(iq, 620, true, phase);
  pushTone(iq, 596, false, phase);
  pushBytes(iq, acuBad, 56, phase, ACU);
}, 3);
function noiseIq(n: number): Float32Array {
  const iq = new Float32Array(n * 2);
  let s = 12345;
  for (let i = 0; i < n * 2; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    iq[i] = (s / 0x7fffffff - 0.5) * 0.05;
  }
  return iq;
}

// --- run + assert -----------------------------------------------------------

let pass = true;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

function run(label: string, iq: Float32Array) {
  const rx = new IsmReceiver();
  rx.process(iq);
  const events = rx.snapshot();
  console.log(
    `\n[${label}] ${rx.totalBursts} bursts, ${rx.totalDecoded} decoded, ${events.length} events`,
  );
  return events;
}

// EV1527
const ev = run("EV1527", evSynth).find((e) => e.model === "EV1527");
check("EV1527 decoded", !!ev, ev);
check("EV1527 code = a53c14", ev?.code === "a53c14", ev?.code);
check("EV1527 id = a53c1", ev?.deviceId === "a53c1", ev?.deviceId);
check("EV1527 repeats folded (≥2)", (ev?.repeats ?? 0) >= 2, ev?.repeats);

// Acurite
const acu = run("Acurite", acuSynth).find((e) => e.model === "Acurite-Tower");
check("Acurite decoded", !!acu, acu);
check("Acurite id = 1234", acu?.deviceId === "1234", acu?.deviceId);
check("Acurite channel = A", acu?.channel === "A", acu?.channel);
check("Acurite temp = 21.3°C", acu?.tempC === 21.3, acu?.tempC);
check("Acurite humidity = 45%", acu?.humidityPct === 45, acu?.humidityPct);
check("Acurite battery ok", acu?.batteryLow === false, acu?.batteryLow);

// LaCrosse — digest-only, so it must repeat before it surfaces
const lac = run("LaCrosse", lacSynth).find((e) => e.model === "LaCrosse-TX");
check("LaCrosse decoded (after repeat)", !!lac, lac);
check("LaCrosse id = 5a", lac?.deviceId === "5a", lac?.deviceId);
check("LaCrosse temp = 19.8°C", lac?.tempC === 19.8, lac?.tempC);
check("LaCrosse humidity = 55%", lac?.humidityPct === 55, lac?.humidityPct);
check("LaCrosse repeats folded (≥2)", (lac?.repeats ?? 0) >= 2, lac?.repeats);

// Acurite 5n1 — temp/humidity message
const a5t = run("Acurite-5n1 T/H", acu5tSynth).find((e) => e.model === "Acurite-5n1");
check("Acurite-5n1 T/H decoded", !!a5t, a5t);
check("Acurite-5n1 id = 01c5", a5t?.deviceId === "01c5", a5t?.deviceId);
check("Acurite-5n1 channel = A", a5t?.channel === "A", a5t?.channel);
check("Acurite-5n1 temp = 21.9°C", a5t?.tempC === 21.9, a5t?.tempC);
check("Acurite-5n1 humidity = 44%", a5t?.humidityPct === 44, a5t?.humidityPct);
check("Acurite-5n1 wind = 10.9 km/h", a5t?.windSpeedKmh === 10.9, a5t?.windSpeedKmh);

// Acurite 5n1 — wind/direction/rain message
const a5r = run("Acurite-5n1 wind/rain", acu5rSynth).find((e) => e.model === "Acurite-5n1");
check("Acurite-5n1 rain decoded", !!a5r, a5r);
check("Acurite-5n1 wind dir = 0°", a5r?.windDirDeg === 0, a5r?.windDirDeg);
check("Acurite-5n1 rain = 25.4 mm", a5r?.rainMm === 25.4, a5r?.rainMm);

// Oregon Scientific v3 (Manchester)
const ore = run("Oregon", oregonSynth).find((e) => e.model === "Oregon");
check("Oregon decoded", !!ore, ore);
check("Oregon id = f824", ore?.deviceId === "f824", ore?.deviceId);
check("Oregon temp = 21.3°C", ore?.tempC === 21.3, ore?.tempC);
check("Oregon humidity = 48%", ore?.humidityPct === 48, ore?.humidityPct);

// Ambient F007TH (Manchester)
const f007 = run("F007TH", f007Synth).find((e) => e.model === "Ambient-F007TH");
check("F007TH decoded", !!f007, f007);
check("F007TH id = 9c", f007?.deviceId === "9c", f007?.deviceId);
check("F007TH temp = 21.9°C", f007?.tempC === 21.9, f007?.tempC);
check("F007TH humidity = 50%", f007?.humidityPct === 50, f007?.humidityPct);

// Honeywell door/window (Manchester, CRC-16)
const hon = run("Honeywell", honeySynth).find((e) => e.model === "Honeywell-Door");
check("Honeywell decoded", !!hon, hon);
check("Honeywell id = 12345", hon?.deviceId === "12345", hon?.deviceId);
check("Honeywell state contains open", !!hon?.data?.includes("open"), hon?.data);

// Nexus-TH (PPM) — no CRC, so it surfaces only after a repeat
const nex = run("Nexus-TH", nexusSynth).find((e) => e.model === "Nexus-TH");
check("Nexus decoded (after repeat)", !!nex, nex);
check("Nexus id = 5a", nex?.deviceId === "5a", nex?.deviceId);
check("Nexus temp = 23.5°C", nex?.tempC === 23.5, nex?.tempC);
check("Nexus humidity = 60%", nex?.humidityPct === 60, nex?.humidityPct);
check("Nexus repeats folded (≥2)", (nex?.repeats ?? 0) >= 2, nex?.repeats);

// Fine Offset WH25 (FSK) — validates the discriminator → NRZ → decode pipeline
const fine = run("Fineoffset-WH25", fineSynth).find((e) => e.model === "Fineoffset-WH25");
check("Fineoffset decoded", !!fine, fine);
check("Fineoffset id = 4d", fine?.deviceId === "4d", fine?.deviceId);
check("Fineoffset temp = 23.4°C", fine?.tempC === 23.4, fine?.tempC);
check("Fineoffset humidity = 58%", fine?.humidityPct === 58, fine?.humidityPct);
check("Fineoffset pressure = 1013.2 hPa", fine?.pressureHpa === 1013.2, fine?.pressureHpa);
check("Fineoffset modulation = FSK", fine?.protocol === "FSK", fine?.protocol);

// Toyota TPMS (FSK differential Manchester)
const toy = run("Toyota-TPMS", toyotaSynth).find((e) => e.model === "Toyota-TPMS");
check("Toyota decoded", !!toy, toy);
check("Toyota id = 01a2b3c4", toy?.deviceId === "01a2b3c4", toy?.deviceId);
check("Toyota temp = 25°C", toy?.tempC === 25, toy?.tempC);
check("Toyota pressure ≈ 220 kPa", Math.abs((toy?.pressureKpa ?? 0) - 220) < 4, toy?.pressureKpa);
check("Toyota modulation = FSK", toy?.protocol === "FSK", toy?.protocol);

// Negative controls — guards must reject corrupted frames and noise.
const bad = run("Acurite-corrupt", acuBadSynth);
check("corrupted Acurite rejected", !bad.some((e) => e.model === "Acurite-Tower"), bad.map((e) => e.model));
const noise = run("Noise", noiseIq(150_000));
const named = noise.filter((e) => e.model !== "OOK" && e.model !== "FSK");
check("noise → no named decode", named.length === 0, named.map((e) => e.model));

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
