// ADS-B sidebar: decode stats, receiver-location controls (for single-frame
// local position fixes + range), and a live, selectable table of every tracked
// aircraft (including those heard but not yet positioned).

import { useRef, useState } from "react";
import type { AircraftReport } from "@sdr/shared";
import { Plane, Crosshair, X } from "lucide-react";
import { Section } from "@/components/Controls";
import { Button } from "@/components/ui/button";
import { icaoInfo, categoryInfo, iso2ToFlag } from "@/lib/icao";
import { useAircraftDb } from "@/lib/aircraft-db";
import { distanceNm } from "@/lib/geo";

interface Props {
  aircraft: AircraftReport[];
  messageRate: number;
  selected: string | null;
  onSelect: (icao: string | null) => void;
  refLat: number | null;
  refLon: number | null;
  onSetRef: (lat: number | null, lon: number | null) => void;
  /** Hide the receiver-location section (when shown once by a parent). */
  hideRef?: boolean;
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

/**
 * Full readout for one selected aircraft: decoded telemetry (always present)
 * plus airframe / operator / route enrichment fetched from adsbdb when online.
 * Self-contained card; the caller positions it (sidebar row or map overlay).
 */
export function AircraftDetail({
  report,
  dist,
  onClose,
}: {
  report: AircraftReport;
  dist: number | null;
  onClose: () => void;
}) {
  const [photoOk, setPhotoOk] = useState(true);
  const info = icaoInfo(report.icao);
  const cat = categoryInfo(report.category);
  const { aircraft: db, route, loading } = useAircraftDb(
    report.icao,
    report.callsign,
  );

  const title =
    report.callsign?.trim() ||
    db?.registration ||
    info.registration ||
    report.icao.toUpperCase();
  const reg = db?.registration || info.registration;
  const country = db?.countryName || info.country;
  const flag =
    info.flag || (db?.countryIso ? iso2ToFlag(db.countryIso) : undefined);
  const typeLine = [db?.manufacturer, db?.type].filter(Boolean).join(" ");
  const sub = [reg, report.icao.toUpperCase(), country].filter(Boolean);

  const fmtRate =
    report.vertRate != null
      ? `${report.vertRate > 0 ? "+" : ""}${report.vertRate.toLocaleString()} fpm`
      : "—";

  return (
    <div className="scroll-thin max-h-full w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-background/95 px-3 py-3 shadow-xl backdrop-blur-sm">
      <div className="flex items-start gap-2.5">
        {db?.photoThumb && photoOk && (
          <img
            src={db.photoThumb}
            alt={typeLine || "aircraft"}
            loading="lazy"
            onError={() => setPhotoOk(false)}
            className="h-12 w-16 shrink-0 rounded-sm border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {flag && <span className="shrink-0">{flag}</span>}
            <span className="truncate font-mono text-sm font-semibold text-foreground">
              {title}
            </span>
            {report.lat != null && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                title="position decoded"
              />
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {sub.join(" · ")}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close aircraft detail"
        >
          <X />
        </Button>
      </div>

      {(typeLine || db?.owner || route?.origin || loading) && (
        <div className="mt-2.5 flex flex-col gap-1 text-[11px]">
          {typeLine && (
            <DetailLine
              label="Type"
              value={db?.icaoType ? `${typeLine} (${db.icaoType})` : typeLine}
            />
          )}
          {db?.owner && <DetailLine label="Operator" value={db.owner} />}
          {route?.airline && <DetailLine label="Airline" value={route.airline} />}
          {route?.origin && route?.destination && (
            <DetailLine
              label="Route"
              value={`${route.origin.iata || route.origin.icao} ${route.origin.municipality} → ${route.destination.iata || route.destination.icao} ${route.destination.municipality}`}
            />
          )}
          {loading && !db && (
            <p className="text-muted-foreground/70">Looking up airframe…</p>
          )}
        </div>
      )}
      {!loading && !db && (
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Not in the airframe database.
        </p>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2.5 font-mono text-[11px]">
        <Metric
          label="ALT"
          value={
            report.altitude != null
              ? `${report.altitude.toLocaleString()} ft`
              : "—"
          }
        />
        <Metric
          label="SPD"
          value={report.speed != null ? `${report.speed} kt` : "—"}
        />
        <Metric
          label="HDG"
          value={report.heading != null ? `${Math.round(report.heading)}°` : "—"}
        />
        <Metric label="V/S" value={fmtRate} />
        <Metric
          label="DIST"
          value={dist != null ? `${dist.toFixed(1)} NM` : "—"}
        />
        <Metric
          label="RSSI"
          value={report.rssi != null ? `${report.rssi.toFixed(0)} dBFS` : "—"}
        />
        <Metric label="CAT" value={cat.label} />
        <Metric
          label="MSGS"
          value={`${report.messages} · ${report.seen.toFixed(0)}s`}
        />
      </div>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground/90">{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground/60">{label}</span>
      <span className="truncate tabular-nums text-foreground/90">{value}</span>
    </div>
  );
}

export function RefControls({
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
