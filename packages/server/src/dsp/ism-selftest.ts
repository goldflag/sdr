// Self-test for the ISM OOK decoder. Synthesizes an EV1527 transmission — a
// 24-bit fixed code sent as on-off keying with a ~300 µs base unit and the
// characteristic 31-unit sync gap between repeats — as 250 kSPS IQ, then runs it
// through the real IsmReceiver and asserts the decoded code/id/data and that the
// repeats fold into one event.
//
//   bun run packages/server/src/dsp/ism-selftest.ts

import { ISM_SAMPLE_RATE } from "@sdr/shared";
import { IsmReceiver } from "./ism";

const CODE = 0xa53c14; // 24-bit: id 0xa53c1 (20 bits) + data 0x4
const UNIT_US = 300; // base pulse unit
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

function synth(): Float32Array {
  const iq: number[] = [];
  const phase = { p: 0 };
  pushTone(iq, 20_000, false, phase); // leading silence so the floor settles
  // Send the codeword several times; the long sync gap separates repeats.
  for (let rep = 0; rep < 4; rep++) {
    for (let bit = 23; bit >= 0; bit--) {
      const one = (CODE >> bit) & 1;
      // '1' = long high + short low; '0' = short high + long low.
      pushTone(iq, one ? 3 * UNIT_US : UNIT_US, true, phase);
      pushTone(iq, one ? UNIT_US : 3 * UNIT_US, false, phase);
    }
    pushTone(iq, UNIT_US, true, phase); // sync pulse
    pushTone(iq, 31 * UNIT_US, false, phase); // long sync gap
  }
  pushTone(iq, 20_000, false, phase);
  return new Float32Array(iq);
}

let pass = true;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) pass = false;
}

const rx = new IsmReceiver();
rx.process(synth());
const events = rx.snapshot();
console.log(
  `\n${rx.totalBursts} bursts, ${rx.totalDecoded} decoded, ${events.length} events\n`,
);

const ev = events.find((e) => e.model === "EV1527");
check("EV1527 decoded", !!ev, events);
check("code = a53c14", ev?.code === "a53c14", ev?.code);
check("device id = a53c1", ev?.deviceId === "a53c1", ev?.deviceId);
check("data = 0x4", ev?.data === "data 0x4", ev?.data);
check("repeats folded (≥2)", (ev?.repeats ?? 0) >= 2, ev?.repeats);
check("single EV1527 event", events.filter((e) => e.model === "EV1527").length === 1, events.length);

console.log(`\n${pass ? "ALL PASSED" : "FAILURES"}`);
process.exit(pass ? 0 : 1);
