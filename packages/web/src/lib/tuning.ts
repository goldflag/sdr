// Shared "go to this signal" helper used by band presets and bookmarks. A
// tuning sets the dongle center frequency (resetting the VFO offset to 0) plus
// mode, bandwidth, and direct-sampling, in the right order.

import type { ClientMessage, DirectSampling, Mode } from "@sdr/shared";

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

/** True if the current radio tuning matches a saved tuning (freq + mode). */
export function tuningMatches(
  t: Tuning,
  centerHz: number,
  vfoOffset: number,
  mode: Mode,
): boolean {
  return Math.abs(centerHz + vfoOffset - t.hz) < 1 && mode === t.mode;
}
