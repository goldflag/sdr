// Runtime validation of incoming ClientMessages. The server cannot trust the
// JSON a socket hands it — a stale client, a curious LAN neighbour, or a plain
// bug could otherwise inject NaN/Infinity into RadioState (poisoning every FFT
// frame) or hand the scanner a malformed config. parseClientMessage returns a
// well-typed message or null; the server drops nulls.

import {
  type AgcMode,
  type ClientMessage,
  type DirectSampling,
  type Mode,
  type ScanConfig,
  type ScanEntry,
  AGC_MODES,
  DIRECT_SAMPLING,
  MODES,
} from "./protocol";

/** Matches the scanner's own MAX_ENTRIES safety cap. */
const MAX_SCAN_ENTRIES = 5000;
const MAX_NOTCHES = 8;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}
function isAgcMode(v: unknown): v is AgcMode {
  return typeof v === "string" && (AGC_MODES as readonly string[]).includes(v);
}
function isDirectSampling(v: unknown): v is DirectSampling {
  return (
    v === DIRECT_SAMPLING.OFF ||
    v === DIRECT_SAMPLING.I_BRANCH ||
    v === DIRECT_SAMPLING.Q_BRANCH
  );
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseScanEntry(v: unknown): ScanEntry | null {
  if (!isObj(v) || !isFiniteNum(v.hz) || !isMode(v.mode)) return null;
  const e: ScanEntry = { hz: v.hz, mode: v.mode };
  if (v.bandwidth !== undefined) {
    if (!isFiniteNum(v.bandwidth) || v.bandwidth <= 0) return null;
    e.bandwidth = v.bandwidth;
  }
  if (v.directSampling !== undefined) {
    if (!isDirectSampling(v.directSampling)) return null;
    e.directSampling = v.directSampling;
  }
  if (v.label !== undefined) {
    if (typeof v.label !== "string") return null;
    e.label = v.label;
  }
  return e;
}

function parseScanConfig(v: unknown): ScanConfig | null {
  if (!isObj(v)) return null;
  if (
    !isFiniteNum(v.thresholdDb) ||
    !isFiniteNum(v.dwellMs) ||
    !isFiniteNum(v.resumeMs)
  ) {
    return null;
  }
  const common = {
    thresholdDb: v.thresholdDb,
    dwellMs: v.dwellMs,
    resumeMs: v.resumeMs,
  };
  if (v.kind === "channels") {
    if (!Array.isArray(v.entries) || v.entries.length > MAX_SCAN_ENTRIES) {
      return null;
    }
    const entries: ScanEntry[] = [];
    for (const raw of v.entries) {
      const e = parseScanEntry(raw);
      if (!e) return null;
      entries.push(e);
    }
    return { kind: "channels", entries, ...common };
  }
  if (v.kind === "range") {
    if (
      !isFiniteNum(v.startHz) ||
      !isFiniteNum(v.stopHz) ||
      !isFiniteNum(v.stepHz) ||
      v.stepHz <= 0 ||
      !isMode(v.mode)
    ) {
      return null;
    }
    const cfg: ScanConfig = {
      kind: "range",
      startHz: v.startHz,
      stopHz: v.stopHz,
      stepHz: v.stepHz,
      mode: v.mode,
      ...common,
    };
    if (v.directSampling !== undefined) {
      if (!isDirectSampling(v.directSampling)) return null;
      cfg.directSampling = v.directSampling;
    }
    return cfg;
  }
  return null;
}

/** Validate a parsed-JSON value as a ClientMessage; null if malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw)) return null;
  const m = raw;
  switch (m.type) {
    case "start":
    case "stop":
    case "scanStop":
    case "scanSkip":
      return { type: m.type };
    case "setFrequency":
    case "setSampleRate":
    case "setBandwidth":
    case "setVfoOffset":
    case "setIsmFreq":
      return isFiniteNum(m.hz) ? { type: m.type, hz: m.hz } : null;
    case "setMode":
      return isMode(m.mode) ? { type: "setMode", mode: m.mode } : null;
    case "setPassband":
      return isFiniteNum(m.low) && isFiniteNum(m.high)
        ? { type: "setPassband", low: m.low, high: m.high }
        : null;
    case "setNr":
      if (!isBool(m.on)) return null;
      if (m.level !== undefined && !isFiniteNum(m.level)) return null;
      return { type: "setNr", on: m.on, level: m.level as number | undefined };
    case "setNb":
      if (!isBool(m.on)) return null;
      if (m.threshold !== undefined && !isFiniteNum(m.threshold)) return null;
      return {
        type: "setNb",
        on: m.on,
        threshold: m.threshold as number | undefined,
      };
    case "setAgc":
      return isAgcMode(m.mode) ? { type: "setAgc", mode: m.mode } : null;
    case "setNotches":
      return Array.isArray(m.notches) &&
        m.notches.length <= MAX_NOTCHES &&
        m.notches.every(isFiniteNum)
        ? { type: "setNotches", notches: m.notches }
        : null;
    case "scanStart": {
      const config = parseScanConfig(m.config);
      return config ? { type: "scanStart", config } : null;
    }
    case "setGain":
      if (m.mode !== "auto" && m.mode !== "manual") return null;
      if (m.db !== undefined && !isFiniteNum(m.db)) return null;
      return { type: "setGain", mode: m.mode, db: m.db as number | undefined };
    case "setSquelch":
      return m.db === null || isFiniteNum(m.db)
        ? { type: "setSquelch", db: m.db }
        : null;
    case "setPpm":
      return isFiniteNum(m.ppm) ? { type: "setPpm", ppm: m.ppm } : null;
    case "setBiasTee":
    case "setAdsb":
    case "setAis":
    case "setAprs":
    case "setIsm":
      return isBool(m.on) ? { type: m.type, on: m.on } : null;
    case "setDirectSampling":
      return isDirectSampling(m.value)
        ? { type: "setDirectSampling", value: m.value }
        : null;
    case "setAdsbRef": {
      const ok = (v: unknown) => v === null || isFiniteNum(v);
      return ok(m.lat) && ok(m.lon)
        ? {
            type: "setAdsbRef",
            lat: m.lat as number | null,
            lon: m.lon as number | null,
          }
        : null;
    }
    default:
      return null;
  }
}
