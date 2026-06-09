// RDS panel for the spectrum sidebar. Broadcast FM stations transmit a 57 kHz
// data subcarrier (Radio Data System) carrying the station name, programme type,
// scrolling RadioText and clock-time. The server decodes it from the WFM
// multiplex; this panel shows the running result. It only applies in WFM mode.

import type { Mode, RdsStation, RdsStats } from "@sdr/shared";
import { Clock, Music, Radio, Mic, RadioTower, Waves } from "lucide-react";
import { Section } from "@/components/Controls";

interface Props {
  station: RdsStation | null;
  stats: RdsStats | null;
  mode: Mode;
}

export function RdsPanel({ station, stats, mode }: Props) {
  const synced = stats?.synced ?? false;
  const aside = mode !== "WFM" ? undefined : synced ? "● lock" : "○ search";

  return (
    <Section title="RDS · FM data" aside={aside}>
      {mode !== "WFM" ? (
        <p className="text-[11px] text-muted-foreground">
          RDS rides on the 57 kHz subcarrier of broadcast FM. Switch to{" "}
          <span className="font-mono">WFM</span> and tune a strong station to
          decode the station name, programme type and RadioText.
        </p>
      ) : !station ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Radio className="size-3.5 animate-pulse" />
          {synced ? "Reading data…" : "Searching for RDS data…"}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* Station identity */}
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <RadioTower className="size-4 self-center text-primary" />
              <span className="font-mono text-lg font-semibold leading-none text-foreground">
                {station.ps || station.callSign || `PI ${station.pi}`}
              </span>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">
              {station.callSign && station.ps ? `${station.callSign} · ` : ""}
              0x{station.pi}
            </span>
          </div>

          {/* Programme type + flags */}
          <div className="flex flex-wrap items-center gap-1">
            {station.ptyName && station.ptyName !== "None" && (
              <Chip>{station.ptyName}</Chip>
            )}
            {station.music !== undefined && (
              <Chip>
                {station.music ? (
                  <>
                    <Music className="size-3 opacity-70" /> Music
                  </>
                ) : (
                  <>
                    <Mic className="size-3 opacity-70" /> Speech
                  </>
                )}
              </Chip>
            )}
            {station.stereo && (
              <Chip>
                <Waves className="size-3 opacity-70" /> Stereo
              </Chip>
            )}
            {station.tp && <Chip>TP</Chip>}
            {station.ta && (
              <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                Traffic
              </span>
            )}
          </div>

          {/* RadioText */}
          {station.radioText && (
            <p className="rounded bg-muted/40 px-2 py-1.5 text-[11px] leading-snug text-foreground/90">
              {station.radioText}
            </p>
          )}

          {/* Clock-time */}
          {station.clock && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="size-3" />
              Station time {formatClock(station.clock.iso)}
            </div>
          )}

          {/* Alternative frequencies */}
          {station.altFreqs && station.altFreqs.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <span className="text-muted-foreground/70">Alt freq: </span>
              <span className="font-mono">
                {station.altFreqs.map((f) => f.toFixed(1)).join(", ")} MHz
              </span>
            </div>
          )}
        </div>
      )}

      {mode === "WFM" && stats && (
        <div className="grid grid-cols-3 gap-1.5 border-t border-border/40 pt-2">
          <Stat label="Groups" value={String(stats.groups)} />
          <Stat
            label="Errors"
            value={stats.synced ? `${(stats.blockErrorRate * 100).toFixed(0)}%` : "—"}
          />
          <Stat label="Sync" value={stats.synced ? "lock" : "—"} />
        </div>
      )}
    </Section>
  );
}

/** Render the "HH:MM ±HH:MM" portion of an RDS clock ISO string. */
function formatClock(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})([+-]\d{2}:\d{2})$/);
  return m ? `${m[1]} (${m[2]})` : iso;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}
