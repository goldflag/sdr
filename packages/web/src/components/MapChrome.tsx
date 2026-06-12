// Presentational chrome for the live map: toolbar buttons, the settings panel,
// the altitude legend, cursor readouts, and the selected-target detail popup.
// All stateless — AdsbMap owns the state and the OpenLayers plumbing.

import type { ReactNode } from "react";
import type {
  AircraftReport,
  StationReport,
  VesselReport,
} from "@sdr/shared";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { categoryInfo, icaoInfo } from "@/lib/icao";
import { aprsKind, aprsKindLabel } from "@/lib/aprs";
import {
  type LabelMode,
  type MapSettings,
  LABEL_MODES,
} from "@/lib/map-settings";

export function MapToolButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant={pressed ? "secondary" : "ghost"}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className="border-0"
    >
      {children}
    </Button>
  );
}

export function MapSettingsPanel({
  settings,
  onChange,
}: {
  settings: MapSettings;
  onChange: (patch: Partial<MapSettings>) => void;
}) {
  return (
    <div className="w-56 rounded-md border bg-popover/95 p-2 text-xs backdrop-blur">
      <div className="mb-2 grid gap-1.5">
        <Label className="text-[11px] text-muted-foreground">Labels</Label>
        <Select
          value={settings.labelMode}
          onValueChange={(v) => onChange({ labelMode: v as LabelMode })}
        >
          <SelectTrigger className="h-7 w-full px-2 font-mono text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {LABEL_MODES.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <MapSwitch
          label="Trails"
          checked={settings.trails}
          onCheckedChange={(trails) => onChange({ trails })}
        />
        <MapSwitch
          label="Range rings"
          checked={settings.rangeRings}
          onCheckedChange={(rangeRings) => onChange({ rangeRings })}
        />
        <MapSwitch
          label="Receiver"
          checked={settings.receiver}
          onCheckedChange={(receiver) => onChange({ receiver })}
        />
        <MapSwitch
          label="Legend"
          checked={settings.legend}
          onCheckedChange={(legend) => onChange({ legend })}
        />
        <MapSwitch
          label="Readouts"
          checked={settings.readouts}
          onCheckedChange={(readouts) => onChange({ readouts })}
        />
        <MapSwitch
          label="Age fade"
          checked={settings.ageFade}
          onCheckedChange={(ageFade) => onChange({ ageFade })}
        />
      </div>
    </div>
  );
}

function MapSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Label className="flex items-center justify-between gap-3 text-[11px] text-foreground/80">
      <span>{label}</span>
      <Switch size="sm" checked={checked} onCheckedChange={onCheckedChange} />
    </Label>
  );
}

export function MapLegend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-52 rounded-md border bg-popover/95 p-2 font-mono text-[10px] text-muted-foreground backdrop-blur">
      <div className="mb-1 flex items-center justify-between">
        <span>Altitude</span>
        <span>ft</span>
      </div>
      <div className="h-2 rounded-sm bg-[linear-gradient(90deg,#22d3ee,#34d399,#fbbf24,#f87171)]" />
      <div className="mt-1 flex justify-between tabular-nums">
        <span>0</span>
        <span>20k</span>
        <span>32k</span>
        <span>40k+</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-[9px]">
        <LegendChip color="#22d3ee" label="ADS-B" />
        <LegendChip color="#2dd4bf" label="AIS" />
        <LegendChip color="#a78bfa" label="APRS" />
      </div>
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="size-2 rounded-full ring-1 ring-background"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

export interface CursorReadout {
  lat: number;
  lon: number;
  dist: number | null;
  brg: number | null;
}

export function MapReadouts({
  cursor,
  zoom,
}: {
  cursor: CursorReadout | null;
  zoom: number;
}) {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex max-w-[calc(100%-16rem)] flex-wrap justify-end gap-x-3 gap-y-1 rounded-md border bg-popover/95 px-2 py-1.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
      <Readout label="Z" value={zoom.toFixed(1)} />
      <Readout label="LAT" value={cursor ? cursor.lat.toFixed(5) : "—"} />
      <Readout label="LON" value={cursor ? cursor.lon.toFixed(5) : "—"} />
      <Readout
        label="DIST"
        value={cursor?.dist != null ? `${cursor.dist.toFixed(1)} NM` : "—"}
      />
      <Readout
        label="BRG"
        value={cursor?.brg != null ? `${cursor.brg.toFixed(0)}°` : "—"}
      />
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <span className="text-muted-foreground/60">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </span>
  );
}

/** Detail rows for the selected aircraft / vessel / APRS station. */
export function TargetPopup({
  aircraft,
  vessel,
  station,
  dist,
  brg,
}: {
  aircraft: AircraftReport | null;
  vessel: VesselReport | null;
  station: StationReport | null;
  dist: number | null;
  brg: number | null;
}) {
  const info = aircraft ? icaoInfo(aircraft.icao) : null;
  return (
    <>
      {aircraft && (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              {aircraft.callsign?.trim() ||
                info?.registration ||
                aircraft.icao.toUpperCase()}
            </span>
            {info?.flag && <span className="text-sm">{info.flag}</span>}
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
            <Row k="ICAO" v={aircraft.icao.toUpperCase()} />
            {info?.registration && <Row k="Reg" v={info.registration} />}
            <Row k="Cat" v={categoryInfo(aircraft.category).label} />
            <Row
              k="Alt"
              v={
                aircraft.altitude != null
                  ? `${aircraft.altitude.toLocaleString()} ft`
                  : "—"
              }
            />
            <Row k="Spd" v={aircraft.speed != null ? `${aircraft.speed} kt` : "—"} />
            <Row k="Hdg" v={aircraft.heading != null ? `${aircraft.heading}°` : "—"} />
            <Row
              k="V/S"
              v={aircraft.vertRate != null ? `${aircraft.vertRate} fpm` : "—"}
            />
            {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
            {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
            <Row k="Sig" v={aircraft.rssi != null ? `${aircraft.rssi} dB` : "—"} />
          </dl>
        </>
      )}
      {!aircraft && vessel && (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              {vessel.name?.trim() || vessel.mmsi}
            </span>
            {vessel.channel && (
              <span className="text-[10px] text-muted-foreground">
                ch {vessel.channel}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
            <Row k="MMSI" v={vessel.mmsi} />
            {vessel.callsign && <Row k="Call" v={vessel.callsign} />}
            <Row
              k="Type"
              v={vessel.shipType ?? (vessel.classB ? "Class B" : "—")}
            />
            <Row k="SOG" v={vessel.sog != null ? `${vessel.sog.toFixed(1)} kt` : "—"} />
            <Row k="COG" v={vessel.cog != null ? `${vessel.cog.toFixed(0)}°` : "—"} />
            <Row k="Hdg" v={vessel.heading != null ? `${vessel.heading}°` : "—"} />
            {vessel.navStatus && <Row k="Status" v={vessel.navStatus} />}
            {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
            {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
            <Row k="Sig" v={vessel.rssi != null ? `${vessel.rssi} dB` : "—"} />
          </dl>
        </>
      )}
      {!aircraft && !vessel && station && (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              {station.call}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {aprsKindLabel(aprsKind(station.symbol))}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
            <Row k="Spd" v={station.speed != null ? `${station.speed} kt` : "—"} />
            <Row k="Crs" v={station.course != null ? `${station.course}°` : "—"} />
            <Row
              k="Alt"
              v={
                station.altitude != null
                  ? `${station.altitude.toLocaleString()} ft`
                  : "—"
              }
            />
            {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
            {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
          </dl>
          {station.via && (
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
              via {station.via}
            </div>
          )}
          {station.comment && (
            <div className="mt-1 text-[10px] text-foreground/75">
              {station.comment}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{k}</dt>
      <dd className="text-right text-foreground/85">{v}</dd>
    </>
  );
}
