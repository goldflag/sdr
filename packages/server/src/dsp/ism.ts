// ISM-band sensor decode, delegated to rtl_433 (https://github.com/merbanan/rtl_433).
//
// We decode nothing ourselves. The radio is tuned to the selected ISM band at
// ISM_SAMPLE_RATE and the *raw* CU8 IQ stream from rtl_tcp is piped straight into
// a child `rtl_433 -r cu8:- … -F json` process; its newline-delimited JSON
// decodes are mapped onto IsmEvent and surfaced to the UI. rtl_433 brings 200+
// device decoders (weather stations, TPMS, energy meters, remotes …).
//
// If the rtl_433 binary isn't on PATH, IsmReceiver.available() is false and the
// server tells the client to disable the ISM tab — there is no built-in fallback.

import type { Subprocess, FileSink } from "bun";
import type { IsmEvent } from "@sdr/shared";
import { ISM_SAMPLE_RATE } from "@sdr/shared";

const EVENT_LOG_MAX = 200; // bound the recent-decode log (the client caps too)

/** rtl_433 invocation: CU8 from stdin, 250 kSPS, JSON out, per-decode level info.
 *  Override entirely with ISM_RTL433_ARGS (space-separated) for debugging — e.g.
 *  ISM_RTL433_ARGS="-r cu8:- -s 250000 -F json -F log -M level -v -v". */
function rtl433Args(): string[] {
  const override = process.env.ISM_RTL433_ARGS;
  if (override) return override.split(/\s+/).filter(Boolean);
  return [
    "-r",
    "cu8:-", // read interleaved uint8 (CU8) IQ from stdin
    "-s",
    String(ISM_SAMPLE_RATE),
    "-F",
    "json", // newline-delimited JSON decodes on stdout
    "-M",
    "level", // attach rssi/snr/noise to each decode
  ];
}

export class IsmReceiver {
  private proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private sink: FileSink | null = null;
  private events: IsmEvent[] = [];
  private nextId = 1;
  private bursts = 0;
  private decoded = 0;
  private noise = -100;

  /** Absolute path to the rtl_433 binary, or null if it isn't installed. Reads
   *  the live PATH explicitly — Bun.which()/Bun.spawn() otherwise snapshot it at
   *  process startup, which misses a PATH set after launch and can make
   *  detection and spawning disagree. */
  static resolve(): string | null {
    return Bun.which("rtl_433", { PATH: process.env.PATH ?? "" });
  }

  /** Whether the rtl_433 binary is installed (decode is impossible without it). */
  static available(): boolean {
    return IsmReceiver.resolve() != null;
  }

  get totalBursts(): number {
    return this.bursts;
  }
  get totalDecoded(): number {
    return this.decoded;
  }
  /** Latest noise level rtl_433 reported (dB), or a floor when none seen yet. */
  get noiseDb(): number {
    return this.noise;
  }

  snapshot(): IsmEvent[] {
    return this.events;
  }

  /** Clear the decode log and counters (e.g. when retuning to another band). */
  reset() {
    this.events = [];
    this.bursts = 0;
    this.decoded = 0;
    this.noise = -100;
  }

  /** Spawn rtl_433 reading raw CU8 from stdin. No-op if unavailable or running. */
  start() {
    const bin = IsmReceiver.resolve();
    if (this.proc || !bin) return;
    this.reset();
    const proc = Bun.spawn([bin, ...rtl433Args()], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      onExit: (p, code, signal) => {
        // stop() nulls this.proc before killing, so this.proc === p means the
        // child exited on its own (crash / bad args). Release it so feed() stops
        // writing to a dead pipe and a later start() can respawn — and surface it,
        // since a silent failure here is indistinguishable from "no signal".
        if (this.proc === p) {
          this.proc = null;
          this.sink = null;
          console.warn(`[ism] rtl_433 exited unexpectedly (code=${code} signal=${signal})`);
        }
      },
    });
    this.proc = proc;
    this.sink = proc.stdin;
    void this.readLoop(proc);
  }

  /** Stop rtl_433 and release the pipe. */
  stop() {
    const proc = this.proc;
    this.proc = null;
    this.sink = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    proc.kill();
  }

  /** Forward a raw CU8 IQ chunk from rtl_tcp to rtl_433's stdin. */
  feed(bytes: Uint8Array) {
    const sink = this.sink;
    if (!sink) return;
    try {
      sink.write(bytes);
      sink.flush();
    } catch {
      // The pipe went away — drop ISM until it is (re)started.
      this.stop();
    }
  }

  /** Read rtl_433's NDJSON stdout, mapping each line to an IsmEvent. */
  private async readLoop(proc: Subprocess<"pipe", "pipe", "ignore">) {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.ingest(line);
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private ingest(line: string) {
    let j: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") return;
      j = parsed as Record<string, unknown>;
    } catch {
      return; // not JSON (shouldn't happen with -F json) — ignore
    }
    // rtl_433 only emits a JSON line once a decoder accepts a packet, so every
    // line is both a "burst" and a "decoded" for our stats.
    this.bursts++;
    this.decoded++;
    const noise = num(j.noise);
    if (noise != null) this.noise = Math.round(noise * 10) / 10;
    this.events.push(mapEvent(j, this.nextId++));
    if (this.events.length > EVENT_LOG_MAX) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX);
    }
  }
}

/** Coerce to a finite number, else undefined. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Map an rtl_433 JSON record onto our IsmEvent shape. */
function mapEvent(j: Record<string, unknown>, id: number): IsmEvent {
  const tempF = num(j.temperature_F);
  const tempC = num(j.temperature_C) ?? (tempF != null ? ((tempF - 32) * 5) / 9 : undefined);
  return {
    id,
    time: Date.now(),
    model: str(j.model) ?? "unknown",
    protocol: str(j.mod) ?? "rtl_433",
    bits: num(j.bits) ?? 0,
    code: str(j.code) ?? "",
    deviceId: j.id != null ? str(j.id) : undefined,
    data: describe(j),
    channel: j.channel != null ? str(j.channel) : undefined,
    tempC: tempC != null ? Math.round(tempC * 10) / 10 : undefined,
    humidityPct: num(j.humidity),
    batteryLow: typeof j.battery_ok === "number" ? j.battery_ok === 0 : undefined,
    windSpeedKmh: num(j.wind_avg_km_h) ?? num(j.wind_speed_km_h) ?? num(j.wind_speed_kmh),
    windDirDeg: num(j.wind_dir_deg) ?? num(j.wind_dir),
    rainMm: num(j.rain_mm) ?? num(j.rain_total_mm),
    pressureHpa: num(j.pressure_hPa),
    pressureKpa: num(j.pressure_kPa),
    repeats: num(j.repeat) ?? 1,
    snrDb: num(j.snr) ?? 0,
  };
}

/** A short human-readable summary from the non-numeric device fields. */
function describe(j: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const key of ["state", "button", "cmd", "event", "status", "alarm"]) {
    if (j[key] != null) parts.push(`${key} ${str(j[key])}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}
