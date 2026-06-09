// APRS sidebar: decode stats, the shared receiver-location controls (for range),
// and a live, selectable table of every heard station — including those heard but
// not yet positioned (status/message-only packets).

import type { StationReport } from "@sdr/shared";
import { RadioTower } from "lucide-react";
import { Section } from "@/components/Controls";
import { RefControls } from "@/components/AdsbPanel";
import { aprsKind, aprsKindLabel } from "@/lib/aprs";
import { distanceNm } from "@/lib/geo";

interface Props {
  stations: StationReport[];
  messageRate: number;
  framesSeen: number;
  selected: string | null;
  onSelect: (call: string | null) => void;
  refLat: number | null;
  refLon: number | null;
  onSetRef: (lat: number | null, lon: number | null) => void;
  hideRef?: boolean;
}

export function AprsPanel(p: Props) {
  const { stations, messageRate, framesSeen, selected, onSelect, refLat, refLon } =
    p;
  const hasRef = refLat != null && refLon != null;
  const positioned = stations.filter((s) => s.lat != null).length;

  const withDist = stations.map((s) => {
    const dist =
      hasRef && s.lat != null
        ? distanceNm(refLat!, refLon!, s.lat, s.lon!)
        : null;
    return { s, dist };
  });
  withDist.sort((x, y) => x.s.seen - y.s.seen);

  return (
    <div className="flex flex-col">
      <Section title="APRS · 144.390 MHz">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Stations" value={String(stations.length)} />
          <Stat label="Located" value={String(positioned)} />
          <Stat label="Bursts heard" value={String(framesSeen)} />
          <Stat label="Msg/s" value={String(messageRate)} />
        </div>
        {stations.length === 0 && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <RadioTower className="mt-px size-3 shrink-0" />
            {framesSeen > 0 ? (
              <span>
                Hearing AX.25 bursts ({framesSeen}) but none decoded cleanly yet
                — keep the antenna <b>vertical</b>. APRS digipeaters are often on
                hilltops, so signals can be strong even inland.
              </span>
            ) : (
              <span>
                Listening on 144.390 MHz. Stations, vehicles and digipeaters
                appear as they beacon. A vertical 2 m antenna helps a lot.
              </span>
            )}
          </p>
        )}
      </Section>

      {!p.hideRef && (
        <Section title="Receiver location" defaultOpen={!hasRef}>
          <RefControls
            refLat={refLat}
            refLon={refLon}
            onSetRef={p.onSetRef}
            hasRef={hasRef}
          />
        </Section>
      )}

      {withDist.length > 0 && (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="text-muted-foreground/70">
              <tr className="border-b">
                <Th>Station</Th>
                {hasRef && <Th className="text-right">Dist</Th>}
                <Th className="text-right">Spd</Th>
                <Th className="text-right">Age</Th>
              </tr>
            </thead>
            <tbody>
              {withDist.map(({ s, dist }) => {
                const isSel = s.call === selected;
                const kind = aprsKind(s.symbol);
                return (
                  <tr
                    key={s.call}
                    onClick={() => onSelect(isSel ? null : s.call)}
                    className={`cursor-pointer border-b border-border/40 last:border-b-0 ${
                      isSel ? "bg-primary/15" : "hover:bg-accent/40"
                    }`}
                  >
                    <Td>
                      <span className="text-foreground">{s.call}</span>
                      {s.lat != null && (
                        <span
                          className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle"
                          title="position decoded"
                        />
                      )}
                      {s.symbol && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {aprsKindLabel(kind)}
                        </span>
                      )}
                    </Td>
                    {hasRef && (
                      <Td className="text-right tabular-nums">
                        {dist != null ? dist.toFixed(0) : "—"}
                      </Td>
                    )}
                    <Td className="text-right tabular-nums">
                      {s.speed != null ? s.speed.toFixed(0) : "—"}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {s.seen.toFixed(0)}s
                    </Td>
                  </tr>
                );
              })}
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
