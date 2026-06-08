// ADS-B sidebar: decode stats, receiver-location controls (for single-frame
// local position fixes + range), and a live, selectable table of every tracked
// aircraft (including those heard but not yet positioned).

import { useRef, useState } from "react";
import type { AircraftReport } from "@sdr/shared";
import { Plane, Crosshair, X } from "lucide-react";
import { Section } from "@/components/Controls";
import { Button } from "@/components/ui/button";
import { icaoInfo } from "@/lib/icao";
import { distanceNm } from "@/lib/geo";

interface Props {
  aircraft: AircraftReport[];
  messageRate: number;
  selected: string | null;
  onSelect: (icao: string | null) => void;
  refLat: number | null;
  refLon: number | null;
  onSetRef: (lat: number | null, lon: number | null) => void;
}

export function AdsbPanel(p: Props) {
  const { aircraft, messageRate, selected, onSelect, refLat, refLon } = p;
  const hasRef = refLat != null && refLon != null;
  const positioned = aircraft.filter((a) => a.lat != null).length;
  const peak = useRef(0);

  const withDist = aircraft.map((a) => {
    const dist =
      hasRef && a.lat != null
        ? distanceNm(refLat!, refLon!, a.lat, a.lon!)
        : null;
    if (dist != null && dist > peak.current) peak.current = dist;
    return { a, dist };
  });
  withDist.sort((x, y) => x.a.seen - y.a.seen);

  return (
    <div className="flex flex-col">
      <Section title="ADS-B · 1090 MHz">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Aircraft" value={String(aircraft.length)} />
          <Stat label="Located" value={String(positioned)} />
          <Stat label="Msg/s" value={String(messageRate)} />
          <Stat
            label="Peak range"
            value={hasRef ? `${peak.current.toFixed(0)} NM` : "—"}
          />
        </div>
        {aircraft.length === 0 && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Plane className="mt-px size-3 shrink-0" />
            Listening… a 1090 MHz antenna with a clear sky view greatly improves
            reception. Aircraft appear as they transmit.
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
                <Th>ID</Th>
                <Th className="text-right">Alt</Th>
                {hasRef && <Th className="text-right">Dist</Th>}
                <Th className="text-right">Spd</Th>
                <Th className="text-right">Age</Th>
              </tr>
            </thead>
            <tbody>
              {withDist.map(({ a, dist }) => {
                const info = icaoInfo(a.icao);
                const isSel = a.icao === selected;
                return (
                  <tr
                    key={a.icao}
                    onClick={() => onSelect(isSel ? null : a.icao)}
                    className={`cursor-pointer border-b border-border/40 last:border-b-0 ${
                      isSel ? "bg-primary/15" : "hover:bg-accent/40"
                    }`}
                  >
                    <Td>
                      {info.flag && <span className="mr-1">{info.flag}</span>}
                      <span className="text-foreground">
                        {a.callsign?.trim() ||
                          info.registration ||
                          a.icao.toUpperCase()}
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
                    {hasRef && (
                      <Td className="text-right tabular-nums">
                        {dist != null ? dist.toFixed(0) : "—"}
                      </Td>
                    )}
                    <Td className="text-right tabular-nums">
                      {a.speed != null ? a.speed : "—"}
                    </Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {a.seen.toFixed(0)}s
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

function RefControls({
  refLat,
  refLon,
  onSetRef,
  hasRef,
}: {
  refLat: number | null;
  refLon: number | null;
  onSetRef: (lat: number | null, lon: number | null) => void;
  hasRef: boolean;
}) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const locate = () => {
    if (!navigator.geolocation) {
      setStatus("Geolocation unavailable");
      return;
    }
    setStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onSetRef(pos.coords.latitude, pos.coords.longitude);
        setStatus(null);
      },
      () => setStatus("Permission denied"),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  const applyManual = () => {
    const la = parseFloat(lat);
    const lo = parseFloat(lon);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      onSetRef(la, lo);
      setStatus(null);
    } else {
      setStatus("Enter valid lat / lon");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">
        Set your location to decode positions from a single message (faster
        fixes) and show range.
      </p>
      {hasRef ? (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-foreground/80">
            {refLat!.toFixed(4)}, {refLon!.toFixed(4)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => onSetRef(null, null)}>
            <X /> Clear
          </Button>
        </div>
      ) : (
        <>
          <Button size="sm" onClick={locate} className="w-full">
            <Crosshair /> Use my location
          </Button>
          <div className="flex items-center gap-1.5">
            <input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="lat"
              inputMode="decimal"
              className="h-7 w-full rounded-md border bg-background px-2 font-mono text-xs"
            />
            <input
              value={lon}
              onChange={(e) => setLon(e.target.value)}
              placeholder="lon"
              inputMode="decimal"
              className="h-7 w-full rounded-md border bg-background px-2 font-mono text-xs"
            />
            <Button size="xs" onClick={applyManual}>
              Set
            </Button>
          </div>
        </>
      )}
      {status && (
        <span className="text-[11px] text-muted-foreground">{status}</span>
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
