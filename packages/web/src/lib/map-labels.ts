// Marker label text and age-fade helpers shared by the map's target layers
// (aircraft / vessels / APRS stations).

import type {
  AircraftReport,
  StationReport,
  VesselReport,
} from "@sdr/shared";
import { icaoInfo } from "@/lib/icao";
import type { LabelMode } from "@/lib/map-settings";

export const STALE_S = 60;

export function targetBaseId(a: AircraftReport): string {
  return (
    a.callsign?.trim() || icaoInfo(a.icao).registration || a.icao.toUpperCase()
  );
}

export function aircraftLabel(
  a: AircraftReport,
  mode: LabelMode,
  selected: boolean,
  zoom: number,
): string {
  if (!shouldShowLabel(mode, selected, zoom)) return "";
  const id = targetBaseId(a);
  if (mode === "idSpeed" && a.speed != null) return `${id}\n${a.speed} kt`;
  if (mode === "idAlt" && a.altitude != null) {
    return `${id}\n${Math.round(a.altitude / 100) * 100} ft`;
  }
  return id;
}

export function vesselMapLabel(
  v: VesselReport,
  mode: LabelMode,
  selected: boolean,
  zoom: number,
): string {
  if (!shouldShowLabel(mode, selected, zoom)) return "";
  const id = v.name?.trim() || v.mmsi;
  if (mode === "idSpeed" && v.sog != null) return `${id}\n${v.sog.toFixed(1)} kt`;
  return id;
}

export function stationMapLabel(
  s: StationReport,
  mode: LabelMode,
  selected: boolean,
  zoom: number,
): string {
  if (!shouldShowLabel(mode, selected, zoom)) return "";
  if (mode === "idAlt" && s.altitude != null) {
    return `${s.call}\n${s.altitude.toLocaleString()} ft`;
  }
  if (mode === "idSpeed" && s.speed != null) return `${s.call}\n${s.speed} kt`;
  return s.call;
}

function shouldShowLabel(mode: LabelMode, selected: boolean, zoom: number): boolean {
  if (mode === "none") return false;
  if (mode === "selected") return selected;
  if (selected) return true;
  return zoom >= 6.4;
}

export function opacityForAge(
  seen: number,
  floor: number,
  ageFade: boolean,
): number {
  return ageFade ? Math.max(floor, 1 - seen / STALE_S) : 1;
}
