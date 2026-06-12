// Synthetic self-test for the carrier squelch gate. No hardware required.
// Run with: bun run src/dsp/squelch-selftest.ts  (or `bun run test:squelch`)
//
// Drives the gate with known per-block power sequences and checks the four
// behaviours it exists to provide: no chatter at the threshold, rejection of
// single-block spikes, hang across short dropouts, and click-free gain ramps.

import { SquelchGate } from "./squelch";

const DT = 0.008; // 8 ms blocks ≈ one 16 KiB rtl_tcp read at 1.024 MSPS
const AUDIO_RATE = 48_000;
const THRESHOLD = -40;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

/** Feed constant `db` for `ms`, returning the open/close transition count. */
function feed(
  gate: SquelchGate,
  db: number | ((block: number) => number),
  ms: number,
  clock: { t: number },
): number {
  let transitions = 0;
  let last: boolean | null = null;
  const blocks = Math.round(ms / 1000 / DT);
  for (let b = 0; b < blocks; b++) {
    clock.t += DT * 1000;
    const p = typeof db === "number" ? db : db(b);
    const open = gate.update(p, THRESHOLD, DT, clock.t);
    if (last != null && open !== last) transitions++;
    last = open;
  }
  return transitions;
}

// --- 1. No chatter on a signal wobbling across the threshold ---------------
{
  const gate = new SquelchGate(AUDIO_RATE);
  const clock = { t: 0 };
  feed(gate, -30, 100, clock); // strong signal: open
  // Raw block power alternating ±1 dB around the threshold toggled the old
  // gate every block; hysteresis (close at −43) must hold this one open.
  const flips = feed(gate, (b) => (b % 2 ? -41 : -39), 1000, clock);
  check("threshold wobble does not chatter", flips === 0, `${flips} flips`);
}

// --- 2. A single-block spike does not pop the gate open --------------------
{
  const gate = new SquelchGate(AUDIO_RATE);
  const clock = { t: 0 };
  feed(gate, -70, 200, clock); // settle on the noise floor
  feed(gate, -35, DT * 1000, clock); // one block, 5 dB over the threshold
  const opened = gate.update(-70, THRESHOLD, DT, (clock.t += DT * 1000));
  check("single-block spike stays closed", !opened);

  // ...but the same level sustained must open within a few blocks.
  feed(gate, -35, 100, clock);
  const open = gate.update(-35, THRESHOLD, DT, (clock.t += DT * 1000));
  check("sustained signal opens", open);
}

// --- 3. Hang rides out a short dropout, then closes ------------------------
{
  const gate = new SquelchGate(AUDIO_RATE);
  const clock = { t: 0 };
  feed(gate, -30, 200, clock); // open
  const flips = feed(gate, -70, 200, clock); // 200 ms fade < 350 ms hang
  check("200 ms dropout rides the hang", flips === 0, `${flips} flips`);
  feed(gate, -30, 100, clock); // signal returns, hang re-arms
  feed(gate, -70, 600, clock); // carrier gone for good
  const open = gate.update(-70, THRESHOLD, DT, (clock.t += DT * 1000));
  check("closes after hang expires", !open);
}

// --- 4. Gain ramp: no per-sample step larger than the ramp slope -----------
{
  const gate = new SquelchGate(AUDIO_RATE);
  const clock = { t: 0 };
  feed(gate, -30, 100, clock); // gate open, but gain still ramps from 0
  // RAMP_S = 5 ms; the slack covers Float32 quantization of the gain values.
  const maxStep = 1 / (0.005 * AUDIO_RATE) + 1e-5;
  const block = () => new Float32Array(384).fill(1);

  const up = gate.shape(block(), true)!;
  let worst = up[0]!; // first sample must already be near 0
  for (let k = 1; k < up.length; k++) {
    worst = Math.max(worst, Math.abs(up[k]! - up[k - 1]!));
  }
  check("open ramp is click-free", worst <= maxStep, `max step ${worst.toFixed(5)}`);
  check("ramp reaches unity", up[up.length - 1] === 1);
  check("steady open passes audio through", gate.shape(block(), true)![10] === 1);

  const down = gate.shape(block(), false)!;
  let worstDown = Math.abs(1 - down[0]!); // no instant cut from unity
  for (let k = 1; k < down.length; k++) {
    worstDown = Math.max(worstDown, Math.abs(down[k]! - down[k - 1]!));
  }
  check("close ramp is click-free", worstDown <= maxStep, `max step ${worstDown.toFixed(5)}`);
  check("fully closed emits nothing", gate.shape(block(), false) === null);
}

// --- 5. Disabled squelch is always open ------------------------------------
{
  const gate = new SquelchGate(AUDIO_RATE);
  const open = gate.update(-120, null, DT, 0);
  check("null threshold is always open", open);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
