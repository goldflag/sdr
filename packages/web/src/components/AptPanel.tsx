// NOAA APT sidebar: satellite picker (NOAA-15/18/19), live decode stats, and the
// practical hints that make or break a reception — you need a bird physically
// overhead and a sky-facing 137 MHz antenna. The main AptView renders the image.

import type { ClientMessage } from "@sdr/shared";
import { NOAA_SATS } from "@sdr/shared";
import { Satellite } from "lucide-react";
import { Section } from "@/components/Controls";
import type { AptStats } from "@/lib/ws";

interface Props {
  stats: AptStats | null;
  aptFreqHz: number;
  send: (msg: ClientMessage) => void;
}

export function AptPanel({ stats, aptFreqHz, send }: Props) {
  const sync = stats?.sync ?? 0;
  const locked = sync > 0.45;
  return (
    <div className="flex flex-col">
      <Section title="NOAA APT · weather satellites">
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Satellite
          </span>
          <div className="grid grid-cols-3 gap-1">
            {NOAA_SATS.map((s) => {
              const active = Math.abs(aptFreqHz - s.hz) < 1000;
              return (
                <button
                  key={s.hz}
                  type="button"
                  onClick={() => send({ type: "setAptSat", hz: s.hz })}
                  className={`rounded-md border px-1.5 py-1 text-[11px] transition-colors ${
                    active
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:bg-accent/40"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="text-center font-mono text-[10px] text-muted-foreground">
            {(aptFreqHz / 1e6).toFixed(4)} MHz
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat label="Lines" value={String(stats?.lines ?? 0)} />
          <Stat
            label="Sync lock"
            value={locked ? `${Math.round(sync * 100)}%` : "—"}
            good={locked}
          />
          <Stat
            label="Signal"
            value={stats ? `${stats.levelDb.toFixed(0)} dB` : "—"}
          />
          <Stat
            label="Status"
            value={locked ? "LOCKED" : "searching"}
            good={locked}
          />
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Satellite className="mt-px size-3 shrink-0" />
          {locked ? (
            <span>
              Locked onto the APT sync — the image is building below, two lines
              per second. Keep decoding until the satellite sets.
            </span>
          ) : (
            <span>
              APT only works while a NOAA bird is <b>overhead</b> (a few ~12-min
              passes a day). Point a sky-facing 137 MHz antenna (V-dipole or QFH)
              up, and check pass times for your location (e.g. n2yo.com). The{" "}
              <b>Sync lock</b> jumps when a pass begins — use it to aim.
            </span>
          )}
        </p>
      </Section>
    </div>
  );
}

function Stat({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-sm tabular-nums ${
          good ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
