// Shared "go to this signal" helper used by band presets and bookmarks. A
// tuning sets the dongle center frequency (resetting the VFO offset to 0) plus
// mode, bandwidth, and direct-sampling, in the right order.

import { LIMITS } from "@sdr/shared";
import type {
  ClientMessage,
  DirectSampling,
  Mode,
  RadioState,
} from "@sdr/shared";

const clampHz = (hz: number) =>
  Math.min(LIMITS.MAX_HZ, Math.max(LIMITS.MIN_HZ, Math.round(hz)));

export interface Tuning {
  /** Target (tuned) frequency in Hz — becomes the dongle center. */
  hz: number;
  mode: Mode;
  /** Optional explicit channel bandwidth; omit to use the mode default. */
  bandwidth?: number;
  directSampling?: DirectSampling;
}

export function applyTuning(
  send: (msg: ClientMessage) => void,
  t: Tuning,
): void {
  send({ type: "setVfoOffset", hz: 0 });
  if (t.directSampling !== undefined) {
    send({ type: "setDirectSampling", value: t.directSampling });
  }
  send({ type: "setFrequency", hz: t.hz });
  // setMode resets bandwidth to the mode default on the server, so send any
  // explicit bandwidth afterwards.
  send({ type: "setMode", mode: t.mode });
  if (t.bandwidth !== undefined) {
    send({ type: "setBandwidth", hz: t.bandwidth });
  }
}

/**
 * Shift the whole monitored band by `factor` of its width. The dongle center
 * frequency moves, carrying the VFO offset with it, so the entire captured band
 * (and the tuned frequency) slides together. `dir < 0` moves down in frequency,
 * `dir > 0` moves up.
 */
export function panBand(
  send: (msg: ClientMessage) => void,
  state: RadioState,
  dir: number,
  factor = 0.1,
): void {
  const step = state.sampleRate * factor;
  const next = clampHz(state.centerHz + Math.sign(dir) * step);
  if (next !== state.centerHz) send({ type: "setFrequency", hz: next });
}

/**
 * Fine-tune the VFO up/down by `stepHz`, keeping it inside the captured band.
 * Once the VFO nears a band edge the whole band scrolls instead, so the tuned
 * frequency keeps advancing smoothly past the edge rather than sticking.
 */
export function nudgeTuned(
  send: (msg: ClientMessage) => void,
  state: RadioState,
  dir: number,
  stepHz: number,
): void {
  const delta = Math.sign(dir) * stepHz;
  const nextOffset = state.vfoOffset + delta;
  const maxOffset = state.sampleRate * 0.45; // keep a margin off the band edge
  if (Math.abs(nextOffset) <= maxOffset) {
    send({ type: "setVfoOffset", hz: Math.round(nextOffset) });
  } else {
    // VFO is at the band edge — scroll the band, leaving the marker in place.
    const next = clampHz(state.centerHz + delta);
    if (next !== state.centerHz) send({ type: "setFrequency", hz: next });
  }
}

/** True if the current radio tuning matches a saved tuning (freq + mode). */
export function tuningMatches(
  t: Tuning,
  centerHz: number,
  vfoOffset: number,
  mode: Mode,
): boolean {
  return Math.abs(centerHz + vfoOffset - t.hz) < 1 && mode === t.mode;
}
