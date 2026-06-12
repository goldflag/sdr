// Map display settings: the basemap catalogue, marker label modes, and
// localStorage persistence with validation of stored values.

import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";

export type BasemapId = "dark" | "light" | "satellite" | "terrain" | "minimal";
export type LabelMode = "none" | "selected" | "id" | "idAlt" | "idSpeed";

export interface MapSettings {
  basemap: BasemapId;
  labelMode: LabelMode;
  trails: boolean;
  rangeRings: boolean;
  receiver: boolean;
  legend: boolean;
  readouts: boolean;
  ageFade: boolean;
}

export const BASEMAPS: {
  id: BasemapId;
  label: string;
  className?: string;
  source: () => OSM | XYZ;
}[] = [
  {
    id: "dark",
    label: "Dark OSM",
    className: "ol-basemap-dark",
    source: () => new OSM(),
  },
  { id: "light", label: "Light OSM", source: () => new OSM() },
  {
    id: "satellite",
    label: "Satellite",
    source: () =>
      new XYZ({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attributions: "Tiles © Esri",
        maxZoom: 19,
      }),
  },
  {
    id: "terrain",
    label: "Terrain",
    source: () =>
      new XYZ({
        url: "https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png",
        attributions: "Map data © OpenStreetMap contributors, SRTM | OpenTopoMap",
        maxZoom: 17,
      }),
  },
  {
    id: "minimal",
    label: "Minimal",
    className: "ol-basemap-minimal",
    source: () =>
      new XYZ({
        url: "https://{a-d}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
        attributions: "© OpenStreetMap contributors © CARTO",
        maxZoom: 20,
      }),
  },
];

export const LABEL_MODES: { id: LabelMode; label: string }[] = [
  { id: "idAlt", label: "ID + altitude" },
  { id: "id", label: "ID only" },
  { id: "idSpeed", label: "ID + speed" },
  { id: "selected", label: "Selected only" },
  { id: "none", label: "None" },
];

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  basemap: "dark",
  labelMode: "idAlt",
  trails: true,
  rangeRings: true,
  receiver: true,
  legend: true,
  readouts: true,
  ageFade: true,
};

const MAP_SETTINGS_KEY = "sdr.map.settings";

export function loadMapSettings(): MapSettings {
  try {
    const raw = localStorage.getItem(MAP_SETTINGS_KEY);
    if (!raw) return DEFAULT_MAP_SETTINGS;
    const v = JSON.parse(raw);
    return {
      ...DEFAULT_MAP_SETTINGS,
      ...v,
      basemap: isBasemap(v?.basemap) ? v.basemap : DEFAULT_MAP_SETTINGS.basemap,
      labelMode: isLabelMode(v?.labelMode)
        ? v.labelMode
        : DEFAULT_MAP_SETTINGS.labelMode,
    };
  } catch {
    return DEFAULT_MAP_SETTINGS;
  }
}

export function saveMapSettings(settings: MapSettings) {
  try {
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

function isBasemap(v: unknown): v is BasemapId {
  return BASEMAPS.some((b) => b.id === v);
}

function isLabelMode(v: unknown): v is LabelMode {
  return LABEL_MODES.some((m) => m.id === v);
}
