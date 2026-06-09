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

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
