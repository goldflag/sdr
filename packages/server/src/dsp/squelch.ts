// Carrier squelch gate. The raw per-block channel power is too twitchy to
// gate audio with directly: a signal sitting at the threshold chatters the
// gate open/closed block by block, a single ignition spike pops it open, and
// a momentary multipath fade chops audio mid-word. This applies the three
// standard receiver fixes — a fast-attack/slow-release power estimate,
// open/close hysteresis, and a hang time — plus a short gain ramp so the
// gate opens and closes without clicks.

/** Estimate rise time constant (s) — bounds how fast the gate can open. */
const ATTACK_TC_S = 0.015;
/** Estimate fall time constant (s) after the carrier drops. */
const RELEASE_TC_S = 0.05;
/** The close threshold sits this far below the open threshold. */
const HYSTERESIS_DB = 3;
/** Stay open this long after the signal drops — rides out mobile flutter. */
const HANG_S = 0.35;
/** Gain fade length (s) at open/close, so the gate doesn't click. */
const RAMP_S = 0.005;

export class SquelchGate {
  private smoothedDb = Number.NaN; // unprimed until the first block
  private open = false;
  private hangUntilMs = 0;
  private gain = 0; // current ramp gain, advanced per audio sample

  constructor(private audioRate: number) {}

  /** Smoothed channel power in dB, for the S-meter / signal broadcast. */
  get levelDb(): number {
    return Number.isNaN(this.smoothedDb) ? -120 : this.smoothedDb;
  }

  /**
   * Feed one block's channel power and decide whether the squelch is open.
   * `dtS` is the block duration in seconds; `thresholdDb` null = squelch off.
   */
  update(
    powerDb: number,
    thresholdDb: number | null,
    dtS: number,
    nowMs: number,
  ): boolean {
    if (Number.isNaN(this.smoothedDb)) {
      this.smoothedDb = powerDb;
    } else {
      const tc = powerDb > this.smoothedDb ? ATTACK_TC_S : RELEASE_TC_S;
      this.smoothedDb += (1 - Math.exp(-dtS / tc)) * (powerDb - this.smoothedDb);
    }

    if (thresholdDb == null) {
      this.open = true;
    } else if (!this.open) {
      if (this.smoothedDb >= thresholdDb) {
        this.open = true;
        this.hangUntilMs = nowMs + HANG_S * 1000;
      }
    } else if (this.smoothedDb >= thresholdDb - HYSTERESIS_DB) {
      // Still above the close threshold: keep pushing the hang window forward.
      this.hangUntilMs = nowMs + HANG_S * 1000;
    } else if (nowMs >= this.hangUntilMs) {
      this.open = false;
    }
    return this.open;
  }

  /**
   * Gate an audio block toward `open`, ramping the gain over RAMP_S so the
   * transition doesn't click. Scales `audio` in place; returns null once the
   * gate is fully closed (nothing should be sent).
   */
  shape(audio: Float32Array, open: boolean): Float32Array | null {
    const target = open ? 1 : 0;
    if (this.gain === target) {
      return target === 1 ? audio : null;
    }
    const step = (target > this.gain ? 1 : -1) / (RAMP_S * this.audioRate);
    let g = this.gain;
    for (let k = 0; k < audio.length; k++) {
      if (g !== target) {
        g += step;
        if (step > 0 ? g > target : g < target) g = target;
      }
      audio[k]! *= g;
    }
    this.gain = g;
    return audio;
  }

  /**
   * Forget the power estimate and close (call on retune — the old channel's
   * power says nothing about the new one). The gain is left where it is: the
   * next shape() call ramps it, whereas zeroing it here would itself click.
   */
  reset() {
    this.smoothedDb = Number.NaN;
    this.open = false;
    this.hangUntilMs = 0;
  }
}
