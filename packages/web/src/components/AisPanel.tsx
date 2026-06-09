// AIS sidebar: decode stats, receiver-location controls (shared with ADS-B for
// range), and a live, selectable table of every tracked vessel (including those
// heard but not yet positioned).

import { useRef } from "react";
import type { VesselReport } from "@sdr/shared";
import { Ship } from "lucide-react";
import { Section } from "@/components/Controls";
import { RefControls } from "@/components/AdsbPanel";
import { distanceNm } from "@/lib/geo";

interface Props {
  vessels: VesselReport[];
  messageRate: number;
  framesSeen: number;
  selected: string | null;
  onSelect: (mmsi: string | null) => void;
  refLat: number | null;
  refLon: number | null;
  onSetRef: (lat: number | null, lon: number | null) => void;
}

export function AisPanel(p: Props) {
  const { vessels, messageRate, framesSeen, selected, onSelect, refLat, refLon } =
    p;
  const hasRef = refLat != null && refLon != null;
  const positioned = vessels.filter((v) => v.lat != null).length;
  const peak = useRef(0);

  const withDist = vessels.map((v) => {
    const dist =
      hasRef && v.lat != null
        ? distanceNm(refLat!, refLon!, v.lat, v.lon!)
        : null;
    if (dist != null && dist > peak.current) peak.current = dist;
    return { v, dist };
  });
  withDist.sort((x, y) => x.v.seen - y.v.seen);

  return (
    <div className="flex flex-col">
      <Section title="AIS · 162 MHz">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Vessels" value={String(vessels.length)} />
          <Stat label="Located" value={String(positioned)} />
          <Stat label="Bursts heard" value={String(framesSeen)} />
          <Stat label="Msg/s" value={String(messageRate)} />
        </div>
        {vessels.length === 0 && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Ship className="mt-px size-3 shrink-0" />
            {framesSeen > 0 ? (
              <span>
                Hearing AIS bursts ({framesSeen}) but none decoded cleanly yet —
                signal is weak. Keep the antenna <b>vertical</b> with a clear view
                toward open water.
              </span>
            ) : (
              <span>
                No AIS bursts yet. For 162 MHz, extend each dipole leg to{" "}
                <b>~46 cm (18 in)</b> and stand the antenna <b>vertical</b>{" "}
                (legs in a straight line, one up / one down), facing the water.
                The “Bursts heard” count rises the moment any AIS energy reaches
                the decoder — use it to aim the antenna.
              </span>
            )}
          </p>
        )}
      </Section>

      <Section title="Receiver location" defaultOpen={!hasRef}>
        <RefControls
          refLat={refLat}
          refLon={refLon}
          onSetRef={p.onSetRef}
          hasRef={hasRef}
        />
      </Section>

      {withDist.length > 0 && (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="text-muted-foreground/70">
              <tr className="border-b">
                <Th>Vessel</Th>
                {hasRef && <Th className="text-right">Dist</Th>}
                <Th className="text-right">Spd</Th>
                <Th className="text-right">Age</Th>
              </tr>
            </thead>
            <tbody>
              {withDist.map(({ v, dist }) => {
                const isSel = v.mmsi === selected;
                return (
                  <tr
                    key={v.mmsi}
                    onClick={() => onSelect(isSel ? null : v.mmsi)}
                    className={`cursor-pointer border-b border-border/40 last:border-b-0 ${
                      isSel ? "bg-primary/15" : "hover:bg-accent/40"
                    }`}
                  >
                    <Td>
                      <span className="text-foreground">
                        {v.name?.trim() || v.mmsi}
                      </span>
                      {v.lat != null && (
                        <span
                          className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle"
                          title="position decoded"
                        />
                      )}
                      {v.shipType && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {v.shipType}
                        </span>
                      )}
                    </Td>
                    {hasRef && (
                      <Td className="text-right tabular-nums">
                        {dist != null ? dist.toFixed(0) : "—"}
                      </Td>
                    )}
                    <Td className="text-right tabular-nums">
                      {v.sog != null ? v.sog.toFixed(1) : "—"}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {v.seen.toFixed(0)}s
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
