// Frequency scanner: steps through a channel list (or a swept range) and parks
// on the first channel whose power exceeds a threshold, resuming after the signal
// drops. It doesn't measure power itself — the Radio feeds it the per-block
// channel power it already computes — and it retunes via the `tune` hook.

import type { ScanConfig, ScanEntry, ScanStatus } from "@sdr/shared";

export interface ScannerHooks {
  tune: (entry: ScanEntry) => void;
  status: (status: ScanStatus | null) => void;
}

const SETTLE_MS = 90; // ignore power right after a retune (PLL settling)
const MAX_ENTRIES = 5000; // safety cap for very wide range sweeps

export class Scanner {
  private entries: ScanEntry[] = [];
  private kind: "channels" | "range" = "channels";
  private threshold = -45;
  private dwellMs = 250;
  private resumeMs = 2000;
  private index = 0;
  private phase: "idle" | "dwell" | "hold" = "idle";
  private tStep = 0; // when the current channel was tuned
  private lastActive = 0;

  constructor(private hooks: ScannerHooks) {}

  get active(): boolean {
    return this.phase !== "idle";
  }
  get holding(): boolean {
    return this.phase === "hold";
  }

  start(cfg: ScanConfig, now: number): boolean {
    const entries = buildEntries(cfg);
    if (entries.length === 0) return false;
    this.entries = entries;
    this.kind = cfg.kind;
    this.threshold = cfg.thresholdDb;
    this.dwellMs = cfg.dwellMs;
    this.resumeMs = cfg.resumeMs;
    this.goto(0, now);
    return true;
  }

  stop() {
    if (this.phase === "idle") return;
    this.phase = "idle";
    this.entries = [];
    this.hooks.status(null);
  }

  skip(now: number) {
    if (this.active) this.step(now);
  }

  /** Fed the current channel power (dB) each IQ block. */
  onPower(powerDb: number, now: number) {
    if (this.phase === "idle") return;
    if (now - this.tStep < SETTLE_MS) return;
    const active = powerDb >= this.threshold;
    if (this.phase === "dwell") {
      if (active) {
        this.phase = "hold";
        this.lastActive = now;
        this.emit();
      } else if (now - this.tStep >= this.dwellMs) {
        this.step(now);
      }
    } else {
      // holding
      if (active) this.lastActive = now;
      else if (now - this.lastActive >= this.resumeMs) this.step(now);
    }
  }

  private goto(i: number, now: number) {
    this.index = i;
    this.phase = "dwell";
    this.tStep = now;
    this.lastActive = now;
    this.hooks.tune(this.entries[i]!);
    this.emit();
  }
  private step(now: number) {
    this.goto((this.index + 1) % this.entries.length, now);
  }
  private emit() {
    const e = this.entries[this.index]!;
    this.hooks.status({
      kind: this.kind,
      index: this.index,
      total: this.entries.length,
      currentHz: e.hz,
      mode: e.mode,
      holding: this.phase === "hold",
    });
  }
}

function buildEntries(cfg: ScanConfig): ScanEntry[] {
  if (cfg.kind === "channels") return cfg.entries.slice(0, MAX_ENTRIES);
  const out: ScanEntry[] = [];
  const step = Math.max(1, cfg.stepHz);
  for (let hz = cfg.startHz; hz <= cfg.stopHz + 1 && out.length < MAX_ENTRIES; hz += step) {
    out.push({ hz: Math.round(hz), mode: cfg.mode, directSampling: cfg.directSampling });
  }
  return out;
}
