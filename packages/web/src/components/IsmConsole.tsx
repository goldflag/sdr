// ISM main view: a live, newest-first log of decoded OOK transmissions, in the
// spirit of rtl_433's console. Named protocols (EV1527, …) show their device id
// and data; unrecognised bursts are logged raw as "OOK" with their sliced bits.

import type { IsmEvent } from "@sdr/shared";
import { RadioReceiver } from "lucide-react";

interface Props {
  events: IsmEvent[];
  freqHz: number;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function IsmConsole({ events, freqHz }: Props) {
  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <RadioReceiver className="size-7 opacity-50" />
        <p className="text-sm">Listening on {(freqHz / 1e6).toFixed(2)} MHz…</p>
        <p className="max-w-sm text-center text-xs text-muted-foreground/80">
          Press a 433 MHz remote, doorbell, TPMS sensor or weather station near
          the antenna. Decoded transmissions appear here as they arrive.
        </p>
      </div>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <table className="w-full text-left font-mono text-xs">
        <thead className="sticky top-0 z-10 bg-background text-muted-foreground/70">
          <tr className="border-b">
            <Th>Time</Th>
            <Th>Model</Th>
            <Th>Proto</Th>
            <Th className="text-right">Bits</Th>
            <Th>Data</Th>
            <Th className="text-right">×</Th>
            <Th className="text-right">SNR</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const named = e.model !== "OOK";
            return (
              <tr
                key={e.id}
                className="border-b border-border/40 hover:bg-accent/30"
              >
                <Td className="text-muted-foreground">{clock(e.time)}</Td>
                <Td>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      named
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {e.model}
                  </span>
                </Td>
                <Td className="text-muted-foreground">{e.protocol}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {e.bits}
                </Td>
                <Td className="text-foreground">
                  {e.deviceId ? (
                    <span>
                      <span className="text-muted-foreground">id</span> {e.deviceId}
                      {e.data ? ` · ${e.data}` : ""}
                    </span>
                  ) : (
                    <span className="text-foreground/80">0x{e.code}</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {e.repeats}
                </Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {e.snrDb.toFixed(0)}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
