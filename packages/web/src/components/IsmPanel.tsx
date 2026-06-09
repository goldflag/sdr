// ISM sidebar: band picker (315 / 434 / 868 / 915 MHz), decode stats, and a hint.
// The main console (IsmConsole) shows the live event log.

import type { ClientMessage } from "@sdr/shared";
import { ISM_BANDS } from "@sdr/shared";
import { RadioReceiver } from "lucide-react";
import { Section } from "@/components/Controls";
import type { IsmStats } from "@/lib/ws";

interface Props {
  stats: IsmStats | null;
  ismFreqHz: number;
  send: (msg: ClientMessage) => void;
}

export function IsmPanel({ stats, ismFreqHz, send }: Props) {
  return (
    <div className="flex flex-col">
      <Section title="ISM · OOK decode">
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Band (MHz)
          </span>
          <div className="grid grid-cols-4 gap-1">
            {ISM_BANDS.map((b) => {
              const active = Math.abs(ismFreqHz - b.hz) < 1000;
              return (
                <button
                  key={b.hz}
                  type="button"
                  onClick={() => send({ type: "setIsmFreq", hz: b.hz })}
                  className={`rounded-md border px-1.5 py-1 font-mono text-[11px] transition-colors ${
                    active
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:bg-accent/40"
                  }`}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat label="Decoded" value={String(stats?.decoded ?? 0)} />
          <Stat
            label="Undecoded"
            value={String(Math.max(0, (stats?.bursts ?? 0) - (stats?.decoded ?? 0)))}
          />
          <Stat
            label="Noise"
            value={stats ? `${stats.noiseDb.toFixed(0)} dB` : "—"}
          />
          <Stat
            label="Freq"
            value={stats ? `${(stats.freqHz / 1e6).toFixed(2)}M` : "—"}
          />
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <RadioReceiver className="mt-px size-3 shrink-0" />
          Decodes on-off-keyed sensors: Acurite &amp; LaCrosse weather stations
          (temp/humidity), plus EV1527 keyfobs and doorbells. Unrecognised bursts
          are counted as “undecoded” and only shown raw on request.
        </p>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}
