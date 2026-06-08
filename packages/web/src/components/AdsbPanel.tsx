// ADS-B sidebar: decode stats plus a live table of every tracked aircraft
// (including those heard but not yet positioned). Sorted by recency.

import type { AircraftReport } from "@sdr/shared";
import { Plane } from "lucide-react";
import { Section } from "@/components/Controls";

interface Props {
  aircraft: AircraftReport[];
  messageRate: number;
}

export function AdsbPanel({ aircraft, messageRate }: Props) {
  const positioned = aircraft.filter((a) => a.lat != null).length;
  const sorted = [...aircraft].sort((a, b) => a.seen - b.seen);

  return (
    <div className="flex flex-col">
      <Section title="ADS-B · 1090 MHz">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Aircraft" value={String(aircraft.length)} />
          <Stat label="Located" value={String(positioned)} />
          <Stat label="Msg/s" value={String(messageRate)} />
        </div>
        {aircraft.length === 0 && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Plane className="mt-px size-3 shrink-0" />
            Listening… a 1090 MHz antenna with a clear sky view greatly improves
            reception. Aircraft appear as they transmit.
          </p>
        )}
      </Section>

      {sorted.length > 0 && (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="text-muted-foreground/70">
              <tr className="border-b">
                <Th>ID</Th>
                <Th className="text-right">Alt</Th>
                <Th className="text-right">Spd</Th>
                <Th className="text-right">Hdg</Th>
                <Th className="text-right">Age</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr
                  key={a.icao}
                  className="border-b border-border/40 last:border-b-0"
                >
                  <Td>
                    <span className="text-foreground">
                      {a.callsign?.trim() || a.icao.toUpperCase()}
                    </span>
                    {a.lat != null && (
                      <span
                        className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle"
                        title="position decoded"
                      />
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {a.altitude != null ? a.altitude.toLocaleString() : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {a.speed != null ? a.speed : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {a.heading != null ? `${a.heading}°` : "—"}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {a.seen.toFixed(0)}s
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-1.5 font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-1 ${className}`}>{children}</td>;
}
