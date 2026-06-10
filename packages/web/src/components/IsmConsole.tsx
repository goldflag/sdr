// ISM main view: a live, newest-first log of decoded OOK transmissions, in the
// spirit of rtl_433's console. Named sensors (Acurite/LaCrosse weather, EV1527
// remotes) render their readings as chips; unrecognised bursts are logged raw as
// "OOK" with their sliced hex and hidden behind a toggle so noise doesn't bury
// the real decodes.

import type { IsmEvent } from "@sdr/shared";
import {
  CloudRain,
  Droplets,
  Gauge,
  RadioReceiver,
  Thermometer,
  Wind,
} from "lucide-react";
import { useState } from "react";

interface Props {
  events: IsmEvent[];
  freqHz: number;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8]!;
}

export function IsmConsole({ events, freqHz }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const hidden = events.filter((e) => e.model === "OOK").length;
  const shown = showRaw ? events : events.filter((e) => e.model !== "OOK");

  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <RadioReceiver className="size-7 opacity-50" />
        <p className="text-sm">Listening on {(freqHz / 1e6).toFixed(2)} MHz…</p>
        <p className="max-w-sm text-center text-xs text-muted-foreground/80">
          Trigger a 433 MHz device near the antenna — a weather station, keyfob,
          doorbell or TPMS sensor. Recognised sensors decode to live readings;
          everything else is logged raw.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {shown.length} {showRaw ? "events" : "decoded"}
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={showRaw}
            onChange={(e) => setShowRaw(e.target.checked)}
            className="size-3 accent-primary"
          />
          Show raw{hidden > 0 ? ` (${hidden})` : ""}
        </label>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No named devices decoded yet. {hidden > 0 ? `${hidden} raw burst${hidden === 1 ? "" : "s"} hidden — tick “Show raw”.` : ""}
          </p>
        ) : (
          <table className="w-full text-left font-mono text-xs">
            <tbody>
              {shown.map((e) => (
                <Row key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({ e }: { e: IsmEvent }) {
  const named = e.model !== "OOK";
  return (
    <tr className="border-b border-border/40 align-middle hover:bg-accent/30">
      <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
        {clock(e.time)}
      </td>
      <td className="px-3 py-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            named ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {e.model}
        </span>
        {e.deviceId && (
          <span className="ml-1.5 text-muted-foreground">
            0x{e.deviceId}
            {e.channel ? <span className="opacity-60"> · ch {e.channel}</span> : null}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <Reading e={e} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
        {e.repeats > 1 ? `×${e.repeats}` : ""}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground/70">
        {e.snrDb.toFixed(0)} dB
      </td>
    </tr>
  );
}

function Reading({ e }: { e: IsmEvent }) {
  // Weather sensors: render readings as chips.
  const isWeather =
    e.tempC !== undefined ||
    e.humidityPct !== undefined ||
    e.windSpeedKmh !== undefined ||
    e.rainMm !== undefined ||
    e.pressureHpa !== undefined ||
    e.pressureKpa !== undefined;
  if (isWeather) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {e.tempC !== undefined && (
          <Chip>
            <Thermometer className="size-3 opacity-70" />
            {e.tempC.toFixed(1)}°C
          </Chip>
        )}
        {e.humidityPct !== undefined && (
          <Chip>
            <Droplets className="size-3 opacity-70" />
            {e.humidityPct}%
          </Chip>
        )}
        {e.windSpeedKmh !== undefined && (
          <Chip>
            <Wind className="size-3 opacity-70" />
            {e.windSpeedKmh.toFixed(1)} km/h
            {e.windDirDeg !== undefined ? ` ${compass(e.windDirDeg)}` : ""}
          </Chip>
        )}
        {e.rainMm !== undefined && (
          <Chip>
            <CloudRain className="size-3 opacity-70" />
            {e.rainMm.toFixed(1)} mm
          </Chip>
        )}
        {e.pressureHpa !== undefined && (
          <Chip>
            <Gauge className="size-3 opacity-70" />
            {e.pressureHpa.toFixed(0)} hPa
          </Chip>
        )}
        {e.pressureKpa !== undefined && (
          <Chip>
            <Gauge className="size-3 opacity-70" />
            {e.pressureKpa.toFixed(0)} kPa
          </Chip>
        )}
        {e.batteryLow && (
          <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
            batt low
          </span>
        )}
      </span>
    );
  }
  // Named-but-not-weather (e.g. EV1527 remotes): show the decoded field.
  if (e.data) return <span className="text-foreground/80">{e.data}</span>;
  // Raw: the sliced hex, dimmed.
  return (
    <span className="text-muted-foreground/70">
      0x{e.code} <span className="opacity-50">· {e.bits} bits</span>
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-foreground tabular-nums">
      {children}
    </span>
  );
}
