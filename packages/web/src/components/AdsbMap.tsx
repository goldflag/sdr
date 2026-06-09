// Live ADS-B / AIS map. Renders each positioned aircraft (category-shaped,
// heading-rotated, altitude-colored) and vessel (heading-rotated ship marker)
// on a dark OpenLayers/OSM map, with fading by age, trails, an optional receiver
// marker + range rings, a click-to-select detail popup, and table<->map
// selection linking.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AircraftReport,
  StationReport,
  VesselReport,
} from "@sdr/shared";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Overlay from "ol/Overlay";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import { circular } from "ol/geom/Polygon";
import { createEmpty, extend, isEmpty } from "ol/extent";
import { fromLonLat, toLonLat } from "ol/proj";
import {
  Icon,
  Style,
  Text,
  Fill,
  Stroke,
  Circle as CircleStyle,
} from "ol/style";
import {
  Crosshair,
  LocateFixed,
  Maximize2,
  Minus,
  Plus,
  Settings2,
} from "lucide-react";
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
import { categoryInfo, icaoInfo, type AircraftKind } from "@/lib/icao";
import {
  aprsKind,
  aprsColor,
  aprsRotates,
  aprsKindLabel,
  type AprsKind,
} from "@/lib/aprs";
import { distanceNm, bearing } from "@/lib/geo";
import "ol/ol.css";

interface Props {
  aircraft?: AircraftReport[];
  vessels?: VesselReport[];
  stations?: StationReport[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  refLat: number | null;
  refLon: number | null;
}

const MAX_TRAIL = 60; // points kept per aircraft trail
const STALE_S = 60;

type BasemapId = "dark" | "light" | "satellite" | "terrain" | "minimal";
type LabelMode = "none" | "selected" | "id" | "idAlt" | "idSpeed";

interface MapSettings {
  basemap: BasemapId;
  labelMode: LabelMode;
  trails: boolean;
  rangeRings: boolean;
  receiver: boolean;
  legend: boolean;
  readouts: boolean;
  ageFade: boolean;
}

const BASEMAPS: {
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

const LABEL_MODES: { id: LabelMode; label: string }[] = [
  { id: "idAlt", label: "ID + altitude" },
  { id: "id", label: "ID only" },
  { id: "idSpeed", label: "ID + speed" },
  { id: "selected", label: "Selected only" },
  { id: "none", label: "None" },
];

const DEFAULT_MAP_SETTINGS: MapSettings = {
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

function loadMapSettings(): MapSettings {
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

function saveMapSettings(settings: MapSettings) {
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

// --- marker icons ----------------------------------------------------------

const SHAPES: Record<AircraftKind, (c: string) => string> = {
  plane: (c) => planeSvg(c, 30),
  heavy: (c) => planeSvg(c, 36),
  light: (c) => planeSvg(c, 22),
  heli: (c) =>
    svg(
      28,
      `<circle cx="12" cy="12" r="3.2" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>` +
        `<line x1="3" y1="3" x2="21" y2="21" stroke="${c}" stroke-width="1.6"/>` +
        `<line x1="21" y1="3" x2="3" y2="21" stroke="${c}" stroke-width="1.6"/>`,
    ),
  ground: (c) =>
    svg(
      20,
      `<rect x="7" y="7" width="10" height="10" rx="2" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>`,
    ),
};

function svg(size: number, body: string): string {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${body}</svg>`,
    )
  );
}

function planeSvg(color: string, size: number): string {
  return svg(
    size,
    `<path d="M12 2 L12.9 9 L21 14 L21 15.8 L12.9 13 L12.9 19 L15.5 20.8 L15.5 22 L12 20.9 L8.5 22 L8.5 20.8 L11.1 19 L11.1 13 L3 15.8 L3 14 L11.1 9 Z" ` +
      `fill="${color}" stroke="#0b0f1a" stroke-width="0.8" stroke-linejoin="round"/>`,
  );
}

// A fresh Icon per update is cheap: OpenLayers caches the decoded image by src,
// so only rotation/opacity vary per aircraft.
function icon(kind: AircraftKind, color: string, rotation: number, opacity: number) {
  return new Icon({
    src: SHAPES[kind](color),
    rotation,
    opacity,
    rotateWithView: true,
  });
}

// Ship marker: a stylised hull pointing "up" (rotated to heading/course).
function shipSvg(color: string): string {
  return svg(
    22,
    `<path d="M12 2 C14 6 15 9 15 14 L15 19 C15 20.5 13.7 21.5 12 21.5 C10.3 21.5 9 20.5 9 19 L9 14 C9 9 10 6 12 2 Z" ` +
      `fill="${color}" stroke="#0b0f1a" stroke-width="0.9" stroke-linejoin="round"/>`,
  );
}

function shipIcon(color: string, rotation: number, opacity: number) {
  return new Icon({ src: shipSvg(color), rotation, opacity, rotateWithView: true });
}

// Colour a vessel by speed over ground: stationary → slate, fast → warm.
function vesselColor(sog?: number): string {
  if (sog == null) return "#94a3b8";
  if (sog < 0.5) return "#64748b"; // moored / anchored
  if (sog < 7) return "#2dd4bf"; // typical transit
  if (sog < 15) return "#38bdf8";
  return "#a78bfa"; // fast craft
}

// APRS station markers: a small glyph per symbol kind. Vehicles/aircraft point
// "up" so they can be rotated to course; fixed stations stay upright.
const APRS_SHAPES: Record<AprsKind, (c: string) => string> = {
  car: (c) =>
    svg(
      18,
      `<rect x="8" y="3" width="8" height="18" rx="2.5" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>` +
        `<rect x="9.5" y="5" width="5" height="4" rx="1" fill="#0b0f1a" opacity="0.5"/>`,
    ),
  truck: (c) =>
    svg(
      18,
      `<rect x="8" y="2" width="8" height="20" rx="1.5" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>` +
        `<rect x="9" y="3.5" width="6" height="5" rx="1" fill="#0b0f1a" opacity="0.5"/>`,
    ),
  bike: (c) =>
    svg(
      14,
      `<circle cx="12" cy="12" r="4" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>`,
    ),
  person: (c) =>
    svg(
      16,
      `<circle cx="12" cy="7" r="2.6" fill="${c}" stroke="#0b0f1a" stroke-width="0.7"/>` +
        `<path d="M7 21 C7 15 9 13 12 13 C15 13 17 15 17 21 Z" fill="${c}" stroke="#0b0f1a" stroke-width="0.7"/>`,
    ),
  home: (c) =>
    svg(
      18,
      `<path d="M12 3 L21 11 L18 11 L18 21 L6 21 L6 11 L3 11 Z" fill="${c}" stroke="#0b0f1a" stroke-width="0.8" stroke-linejoin="round"/>`,
    ),
  wx: (c) =>
    svg(
      18,
      `<circle cx="12" cy="12" r="8" fill="none" stroke="${c}" stroke-width="2.2"/>` +
        `<circle cx="12" cy="12" r="2.5" fill="${c}"/>`,
    ),
  balloon: (c) =>
    svg(
      18,
      `<circle cx="12" cy="10" r="7" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>` +
        `<line x1="12" y1="17" x2="12" y2="22" stroke="${c}" stroke-width="1.4"/>`,
    ),
  boat: (c) => shipSvg(c),
  aircraft: (c) => planeSvg(c, 24),
  digi: (c) =>
    svg(
      18,
      `<path d="M12 3 L20 12 L12 21 L4 12 Z" fill="${c}" stroke="#0b0f1a" stroke-width="0.9" stroke-linejoin="round"/>`,
    ),
  phone: (c) =>
    svg(
      16,
      `<rect x="8.5" y="3" width="7" height="18" rx="2" fill="${c}" stroke="#0b0f1a" stroke-width="0.8"/>`,
    ),
  dot: (c) =>
    svg(
      14,
      `<circle cx="12" cy="12" r="5" fill="${c}" stroke="#0b0f1a" stroke-width="0.9"/>`,
    ),
};

function aprsIcon(
  kind: AprsKind,
  color: string,
  rotation: number,
  opacity: number,
) {
  return new Icon({
    src: APRS_SHAPES[kind](color),
    rotation,
    opacity,
    rotateWithView: true,
  });
}

function altColor(alt?: number): string {
  if (alt == null) return "#9ca3af";
  const t = Math.min(1, Math.max(0, alt / 40000));
  const stops: [number, string][] = [
    [0, "#22d3ee"],
    [0.5, "#34d399"],
    [0.8, "#fbbf24"],
    [1, "#f87171"],
  ];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i]![0]) return stops[i]![1];
  return "#f87171";
}

function targetBaseId(a: AircraftReport): string {
  return (
    a.callsign?.trim() || icaoInfo(a.icao).registration || a.icao.toUpperCase()
  );
}

function aircraftLabel(
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

function vesselMapLabel(
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

function stationMapLabel(
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

function opacityForAge(seen: number, floor: number, ageFade: boolean): number {
  return ageFade ? Math.max(floor, 1 - seen / STALE_S) : 1;
}

// --- smooth motion (dead reckoning) ----------------------------------------
//
// ADS-B position fixes land every few seconds, so markers would otherwise jump.
// Between fixes we extrapolate each aircraft forward from its last reported
// position along its heading at its ground speed, every animation frame. When a
// fresh fix arrives we don't snap to it: we record the small offset between
// where the marker is and where the new fix predicts, then bleed that offset off
// over MOTION_CORRECT_MS so the path stays continuous.

const MOTION_CORRECT_MS = 700; // ease a position correction over this window
const MAX_EXTRAPOLATE_S = 8; // cap dead reckoning so a stalled feed can't fling markers
const KNOTS_TO_MS = 0.514444;

interface MotionState {
  lat: number;
  lon: number;
  speed: number; // knots; 0 = stationary/unknown -> no extrapolation
  heading: number; // degrees
  epoch: number; // client ms the reported position was valid
  corr: [number, number]; // residual mercator offset, bled off after a correction
  corrEpoch: number; // client ms the correction was applied
}

// Move a lat/lon forward by distM metres along a compass bearing (great-circle).
function projectLatLon(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): [number, number] {
  const R = 6378137;
  const d = distM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

function predictLonLat(m: MotionState, now: number): [number, number] {
  if (m.speed <= 0.5) return [m.lon, m.lat];
  const elapsed = Math.min((now - m.epoch) / 1000, MAX_EXTRAPOLATE_S);
  if (elapsed <= 0) return [m.lon, m.lat];
  return projectLatLon(m.lat, m.lon, m.heading, m.speed * KNOTS_TO_MS * elapsed);
}

// Rendered mercator coordinate: extrapolated position + the decaying correction.
function motionCoord(m: MotionState, now: number): number[] {
  const [lon, lat] = predictLonLat(m, now);
  const merc = fromLonLat([lon, lat]);
  const k = Math.max(0, 1 - (now - m.corrEpoch) / MOTION_CORRECT_MS);
  return [merc[0]! + m.corr[0] * k, merc[1]! + m.corr[1] * k];
}

export function AdsbMap({
  aircraft = [],
  vessels = [],
  stations = [],
  selected,
  onSelect,
  refLat,
  refLon,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const basemapLayers = useRef(new Map<BasemapId, TileLayer>());
  const planeSrc = useRef<VectorSource | null>(null);
  const trailSrc = useRef<VectorSource | null>(null);
  const rangeSrc = useRef<VectorSource | null>(null);
  const shipSrc = useRef<VectorSource | null>(null);
  const shipTrailSrc = useRef<VectorSource | null>(null);
  const stationSrc = useRef<VectorSource | null>(null);
  const stationTrailSrc = useRef<VectorSource | null>(null);
  const trailLayer = useRef<VectorLayer<VectorSource> | null>(null);
  const shipTrailLayer = useRef<VectorLayer<VectorSource> | null>(null);
  const stationTrailLayer = useRef<VectorLayer<VectorSource> | null>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const planeFeats = useRef(new Map<string, Feature>());
  const trailFeats = useRef(new Map<string, Feature>());
  const trails = useRef(new Map<string, number[][]>());
  const motion = useRef(new Map<string, MotionState>());
  const motionStamp = useRef<AircraftReport[] | null>(null);
  const reducedMotion = useRef(false);
  const shipFeats = useRef(new Map<string, Feature>());
  const shipTrailFeats = useRef(new Map<string, Feature>());
  const shipTrails = useRef(new Map<string, number[][]>());
  const stationFeats = useRef(new Map<string, Feature>());
  const stationTrailFeats = useRef(new Map<string, Feature>());
  const stationTrails = useRef(new Map<string, number[][]>());
  const didFit = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refPos = useRef<{ lat: number | null; lon: number | null }>({
    lat: refLat,
    lon: refLon,
  });
  refPos.current = { lat: refLat, lon: refLon };
  const [settings, setSettings] = useState<MapSettings>(loadMapSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [followSelected, setFollowSelected] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(4);
  const [cursor, setCursor] = useState<{
    lat: number;
    lon: number;
    dist: number | null;
    brg: number | null;
  } | null>(null);

  const setMapSettings = (patch: Partial<MapSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveMapSettings(next);
      return next;
    });
  };

  const selectedAircraft = useMemo(
    () => aircraft.find((a) => a.icao === selected) ?? null,
    [aircraft, selected],
  );
  const selectedVessel = useMemo(
    () => vessels.find((v) => v.mmsi === selected) ?? null,
    [vessels, selected],
  );
  const selectedStation = useMemo(
    () => stations.find((s) => s.call === selected) ?? null,
    [stations, selected],
  );

  // One-time map setup.
  useEffect(() => {
    if (!elRef.current) return;
    const planes = new VectorSource();
    const trailV = new VectorSource();
    const range = new VectorSource();
    const ships = new VectorSource();
    const shipTrailV = new VectorSource();
    const stns = new VectorSource();
    const stnTrailV = new VectorSource();
    planeSrc.current = planes;
    trailSrc.current = trailV;
    rangeSrc.current = range;
    shipSrc.current = ships;
    shipTrailSrc.current = shipTrailV;
    stationSrc.current = stns;
    stationTrailSrc.current = stnTrailV;

    const baseLayers = BASEMAPS.map((b) => {
      const layer = new TileLayer({
        source: b.source(),
        className: b.className,
        visible: b.id === settings.basemap,
      });
      basemapLayers.current.set(b.id, layer);
      return layer;
    });
    const trailVLayer = new VectorLayer({
      source: trailV,
      visible: settings.trails,
    });
    const shipTrailVLayer = new VectorLayer({
      source: shipTrailV,
      visible: settings.trails,
    });
    const stnTrailVLayer = new VectorLayer({
      source: stnTrailV,
      visible: settings.trails,
    });
    trailLayer.current = trailVLayer;
    shipTrailLayer.current = shipTrailVLayer;
    stationTrailLayer.current = stnTrailVLayer;

    const map = new OLMap({
      target: elRef.current,
      layers: [
        ...baseLayers,
        new VectorLayer({ source: range }),
        trailVLayer,
        shipTrailVLayer,
        stnTrailVLayer,
        new VectorLayer({ source: ships }),
        new VectorLayer({ source: stns }),
        new VectorLayer({ source: planes }),
      ],
      view: new View({ center: fromLonLat([-98, 39]), zoom: 4 }),
      controls: [],
    });
    mapRef.current = map;

    if (popupRef.current) {
      const overlay = new Overlay({
        element: popupRef.current,
        positioning: "bottom-center",
        offset: [0, -20],
        stopEvent: false,
      });
      map.addOverlay(overlay);
      overlayRef.current = overlay;
    }

    map.on("singleclick", (e) => {
      let hit: string | null = null;
      map.forEachFeatureAtPixel(
        e.pixel,
        (f) => {
          const id = f.get("icao") ?? f.get("mmsi") ?? f.get("call");
          if (id) {
            hit = id;
            return true;
          }
        },
        { hitTolerance: 6 },
      );
      onSelectRef.current(hit);
    });

    map.on("pointermove", (e) => {
      const lonLat = toLonLat(e.coordinate);
      const lon = lonLat[0] ?? 0;
      const lat = lonLat[1] ?? 0;
      const rp = refPos.current;
      const hasRef = rp.lat != null && rp.lon != null;
      setCursor({
        lat,
        lon,
        dist: hasRef ? distanceNm(rp.lat!, rp.lon!, lat, lon) : null,
        brg: hasRef ? bearing(rp.lat!, rp.lon!, lat, lon) : null,
      });
    });

    const target = map.getTargetElement();
    target.addEventListener("mouseleave", () => setCursor(null));

    const view = map.getView();
    const syncZoom = () => setZoom(view.getZoom() ?? 0);
    view.on("change:resolution", syncZoom);
    syncZoom();

    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
      basemapLayers.current.clear();
      trailLayer.current = null;
      shipTrailLayer.current = null;
      stationTrailLayer.current = null;
    };
  }, []);

  useEffect(() => {
    for (const [id, layer] of basemapLayers.current) {
      layer.setVisible(id === settings.basemap);
    }
  }, [settings.basemap]);

  useEffect(() => {
    trailLayer.current?.setVisible(settings.trails);
    shipTrailLayer.current?.setVisible(settings.trails);
    stationTrailLayer.current?.setVisible(settings.trails);
  }, [settings.trails]);

  useEffect(() => {
    const onFullscreen = () => {
      setFullscreen(document.fullscreenElement === rootRef.current);
      window.setTimeout(() => mapRef.current?.updateSize(), 40);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    if (!followSelected) return;
    const target = selectedAircraft ?? selectedVessel ?? selectedStation;
    if (target?.lat == null || target.lon == null) return;
    mapRef.current
      ?.getView()
      .animate({ center: fromLonLat([target.lon, target.lat]), duration: 250 });
  }, [followSelected, selectedAircraft, selectedVessel, selectedStation]);

  const zoomBy = (delta: number) => {
    const view = mapRef.current?.getView();
    if (!view) return;
    const current = view.getZoom() ?? zoom;
    view.animate({ zoom: current + delta, duration: 150 });
  };

  const centerReceiver = () => {
    if (refLat == null || refLon == null) return;
    mapRef.current
      ?.getView()
      .animate({ center: fromLonLat([refLon, refLat]), zoom: Math.max(zoom, 8), duration: 250 });
  };

  const fitVisibleTargets = () => {
    const view = mapRef.current?.getView();
    if (!view) return;
    const extent = createEmpty();
    for (const src of [planeSrc.current, shipSrc.current, stationSrc.current]) {
      for (const f of src?.getFeatures() ?? []) {
        const geom = f.getGeometry();
        if (geom) extend(extent, geom.getExtent());
      }
    }
    if (isEmpty(extent)) {
      centerReceiver();
      return;
    }
    view.fit(extent, { padding: [80, 80, 80, 80], maxZoom: 11, duration: 300 });
  };

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen();
  };

  // Receiver marker + range rings.
  useEffect(() => {
    const src = rangeSrc.current;
    if (!src) return;
    src.clear();
    if (refLat == null || refLon == null) return;
    const center = [refLon, refLat];
    if (settings.rangeRings) {
      for (const nm of [50, 100, 150, 200]) {
        const ring = new Feature(
          circular(center, nm * 1852, 96).transform("EPSG:4326", "EPSG:3857"),
        );
        ring.setStyle(
          new Style({
            stroke: new Stroke({ color: "rgba(120,160,200,0.28)", width: 1 }),
            text: new Text({
              text: `${nm}`,
              font: "10px ui-monospace, monospace",
              fill: new Fill({ color: "rgba(150,180,210,0.6)" }),
              offsetY: -6,
              placement: "line",
            }),
          }),
        );
        src.addFeature(ring);
      }
    }
    if (!settings.receiver) return;
    const me = new Feature(new Point(fromLonLat(center)));
    me.setStyle(
      new Style({
        image: new CircleStyle({
          radius: 5,
          fill: new Fill({ color: "#60a5fa" }),
          stroke: new Stroke({ color: "#0b0f1a", width: 1.5 }),
        }),
      }),
    );
    src.addFeature(me);
  }, [refLat, refLon, settings.rangeRings, settings.receiver]);

  // Track the OS "reduce motion" preference; when set, markers step with the
  // data instead of being animated between fixes.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => (reducedMotion.current = mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Animation loop: dead-reckon every aircraft forward each frame so they fly
  // continuously between position fixes. Static/stale aircraft (speed 0) hold
  // their reported coordinate, so this is cheap even with a busy sky.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (reducedMotion.current) return;
      const now = Date.now();
      for (const [icao, m] of motion.current) {
        // Nothing to animate for a parked marker with no pending correction.
        if (m.speed <= 0.5 && now - m.corrEpoch > MOTION_CORRECT_MS) continue;
        const f = planeFeats.current.get(icao);
        if (f) (f.getGeometry() as Point).setCoordinates(motionCoord(m, now));
      }
      // Keep the on-map popup glued to the selected aircraft as it moves.
      const sel = selectedRef.current;
      if (sel) {
        const m = motion.current.get(sel);
        if (m) overlayRef.current?.setPosition(motionCoord(m, now));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Sync aircraft markers + trails with the latest snapshot.
  useEffect(() => {
    const psrc = planeSrc.current;
    const tsrc = trailSrc.current;
    if (!psrc || !tsrc) return;
    const seen = new Set<string>();
    // Only re-seed motion when the data actually changed (not on a zoom/label
    // restyle, which reruns this effect with the same array reference).
    const now = Date.now();
    const fresh = aircraft !== motionStamp.current;
    if (fresh) motionStamp.current = aircraft;

    for (const a of aircraft) {
      if (a.lat == null || a.lon == null) continue;
      seen.add(a.icao);
      const coord = fromLonLat([a.lon, a.lat]);
      const color = altColor(a.altitude);
      const { kind } = categoryInfo(a.category);
      const opacity = opacityForAge(a.seen, 0.35, settings.ageFade);
      const isSel = a.icao === selected;

      // Trail history.
      let path = trails.current.get(a.icao);
      if (!path) {
        path = [];
        trails.current.set(a.icao, path);
      }
      const last = path[path.length - 1];
      if (!last || last[0] !== coord[0] || last[1] !== coord[1]) {
        path.push(coord);
        if (path.length > MAX_TRAIL) path.shift();
      }
      let tf = trailFeats.current.get(a.icao);
      if (!tf) {
        tf = new Feature(new LineString(path));
        trailFeats.current.set(a.icao, tf);
        tsrc.addFeature(tf);
      } else {
        (tf.getGeometry() as LineString).setCoordinates(path);
      }
      tf.setStyle(
        new Style({
          stroke: new Stroke({
            color: isSel ? color : "rgba(160,160,180,0.45)",
            width: isSel ? 2 : 1,
          }),
        }),
      );

      // Marker.
      let f = planeFeats.current.get(a.icao);
      if (!f) {
        f = new Feature({ geometry: new Point(coord) });
        f.set("icao", a.icao);
        planeFeats.current.set(a.icao, f);
        psrc.addFeature(f);
      } else if (reducedMotion.current) {
        // Animated path lets the rAF loop own the geometry; here we step it.
        (f.getGeometry() as Point).setCoordinates(coord);
      }

      // Re-seed the motion model from this fix, preserving visual continuity.
      if (fresh) {
        const moving =
          a.speed != null &&
          a.speed > 0.5 &&
          a.heading != null &&
          a.seen <= MAX_EXTRAPOLATE_S;
        const next: MotionState = {
          lat: a.lat,
          lon: a.lon,
          speed: moving ? a.speed! : 0,
          heading: a.heading ?? 0,
          epoch: now - Math.min(a.seen, MAX_EXTRAPOLATE_S) * 1000,
          corr: [0, 0],
          corrEpoch: now,
        };
        const prev = motion.current.get(a.icao);
        if (prev) {
          const rendered = motionCoord(prev, now);
          const base = fromLonLat(predictLonLat(next, now));
          next.corr = [rendered[0]! - base[0]!, rendered[1]! - base[1]!];
        }
        motion.current.set(a.icao, next);
      }

      const styles: Style[] = [];
      if (isSel) {
        styles.push(
          new Style({
            image: new CircleStyle({
              radius: 16,
              stroke: new Stroke({ color: "#e5e7eb", width: 2 }),
              fill: new Fill({ color: "rgba(229,231,235,0.12)" }),
            }),
          }),
        );
      }
      styles.push(
        new Style({
          image: icon(kind, color, ((a.heading ?? 0) * Math.PI) / 180, opacity),
          text: new Text({
            text: aircraftLabel(a, settings.labelMode, isSel, zoom),
            offsetY: 24,
            font: "600 11px ui-monospace, Menlo, monospace",
            fill: new Fill({ color: "#e8edf6" }),
            stroke: new Stroke({ color: "rgba(8,12,20,0.9)", width: 3 }),
            textAlign: "center",
          }),
        }),
      );
      f.setStyle(styles);
    }

    // Drop aircraft that aged out of the snapshot.
    for (const [icao, f] of planeFeats.current) {
      if (!seen.has(icao)) {
        psrc.removeFeature(f);
        planeFeats.current.delete(icao);
        motion.current.delete(icao);
        const tf = trailFeats.current.get(icao);
        if (tf) {
          tsrc.removeFeature(tf);
          trailFeats.current.delete(icao);
        }
        trails.current.delete(icao);
      }
    }

    fitOnce(psrc);
  }, [aircraft, selected, settings.ageFade, settings.labelMode, zoom]);

  // Sync vessel markers + trails with the latest snapshot.
  useEffect(() => {
    const ssrc = shipSrc.current;
    const tsrc = shipTrailSrc.current;
    if (!ssrc || !tsrc) return;
    const seen = new Set<string>();

    for (const v of vessels) {
      if (v.lat == null || v.lon == null) continue;
      seen.add(v.mmsi);
      const coord = fromLonLat([v.lon, v.lat]);
      const color = vesselColor(v.sog);
      const opacity = opacityForAge(v.seen, 0.4, settings.ageFade);
      const isSel = v.mmsi === selected;
      // Heading if transmitted, else course over ground.
      const rot = ((v.heading ?? v.cog ?? 0) * Math.PI) / 180;

      // Trail history.
      let path = shipTrails.current.get(v.mmsi);
      if (!path) {
        path = [];
        shipTrails.current.set(v.mmsi, path);
      }
      const last = path[path.length - 1];
      if (!last || last[0] !== coord[0] || last[1] !== coord[1]) {
        path.push(coord);
        if (path.length > MAX_TRAIL) path.shift();
      }
      let tf = shipTrailFeats.current.get(v.mmsi);
      if (!tf) {
        tf = new Feature(new LineString(path));
        shipTrailFeats.current.set(v.mmsi, tf);
        tsrc.addFeature(tf);
      } else {
        (tf.getGeometry() as LineString).setCoordinates(path);
      }
      tf.setStyle(
        new Style({
          stroke: new Stroke({
            color: isSel ? color : "rgba(120,180,190,0.4)",
            width: isSel ? 2 : 1,
          }),
        }),
      );

      // Marker.
      let f = shipFeats.current.get(v.mmsi);
      if (!f) {
        f = new Feature({ geometry: new Point(coord) });
        f.set("mmsi", v.mmsi);
        shipFeats.current.set(v.mmsi, f);
        ssrc.addFeature(f);
      } else {
        (f.getGeometry() as Point).setCoordinates(coord);
      }
      const styles: Style[] = [];
      if (isSel) {
        styles.push(
          new Style({
            image: new CircleStyle({
              radius: 14,
              stroke: new Stroke({ color: "#e5e7eb", width: 2 }),
              fill: new Fill({ color: "rgba(229,231,235,0.12)" }),
            }),
          }),
        );
      }
      styles.push(
        new Style({
          image: shipIcon(color, rot, opacity),
          text: new Text({
            text: vesselMapLabel(v, settings.labelMode, isSel, zoom),
            offsetY: 22,
            font: "600 11px ui-monospace, Menlo, monospace",
            fill: new Fill({ color: "#e8edf6" }),
            stroke: new Stroke({ color: "rgba(8,12,20,0.9)", width: 3 }),
            textAlign: "center",
          }),
        }),
      );
      f.setStyle(styles);
    }

    // Drop vessels that aged out of the snapshot.
    for (const [mmsi, f] of shipFeats.current) {
      if (!seen.has(mmsi)) {
        ssrc.removeFeature(f);
        shipFeats.current.delete(mmsi);
        const tf = shipTrailFeats.current.get(mmsi);
        if (tf) {
          tsrc.removeFeature(tf);
          shipTrailFeats.current.delete(mmsi);
        }
        shipTrails.current.delete(mmsi);
      }
    }

    fitOnce(ssrc);
  }, [vessels, selected, settings.ageFade, settings.labelMode, zoom]);

  // Sync APRS station markers + trails with the latest snapshot.
  useEffect(() => {
    const psrc = stationSrc.current;
    const tsrc = stationTrailSrc.current;
    if (!psrc || !tsrc) return;
    const seen = new Set<string>();

    for (const s of stations) {
      if (s.lat == null || s.lon == null) continue;
      seen.add(s.call);
      const coord = fromLonLat([s.lon, s.lat]);
      const kind = aprsKind(s.symbol);
      const color = aprsColor(kind);
      const opacity = opacityForAge(s.seen, 0.4, settings.ageFade);
      const isSel = s.call === selected;
      const rot =
        aprsRotates(kind) && s.course != null
          ? (s.course * Math.PI) / 180
          : 0;

      // Trail history (moving stations).
      let path = stationTrails.current.get(s.call);
      if (!path) {
        path = [];
        stationTrails.current.set(s.call, path);
      }
      const last = path[path.length - 1];
      if (!last || last[0] !== coord[0] || last[1] !== coord[1]) {
        path.push(coord);
        if (path.length > MAX_TRAIL) path.shift();
      }
      let tf = stationTrailFeats.current.get(s.call);
      if (!tf) {
        tf = new Feature(new LineString(path));
        stationTrailFeats.current.set(s.call, tf);
        tsrc.addFeature(tf);
      } else {
        (tf.getGeometry() as LineString).setCoordinates(path);
      }
      tf.setStyle(
        new Style({
          stroke: new Stroke({
            color: isSel ? color : "rgba(160,170,190,0.4)",
            width: isSel ? 2 : 1,
          }),
        }),
      );

      // Marker.
      let f = stationFeats.current.get(s.call);
      if (!f) {
        f = new Feature({ geometry: new Point(coord) });
        f.set("call", s.call);
        stationFeats.current.set(s.call, f);
        psrc.addFeature(f);
      } else {
        (f.getGeometry() as Point).setCoordinates(coord);
      }
      const styles: Style[] = [];
      if (isSel) {
        styles.push(
          new Style({
            image: new CircleStyle({
              radius: 14,
              stroke: new Stroke({ color: "#e5e7eb", width: 2 }),
              fill: new Fill({ color: "rgba(229,231,235,0.12)" }),
            }),
          }),
        );
      }
      styles.push(
        new Style({
          image: aprsIcon(kind, color, rot, opacity),
          text: new Text({
            text: stationMapLabel(s, settings.labelMode, isSel, zoom),
            offsetY: 20,
            font: "600 11px ui-monospace, Menlo, monospace",
            fill: new Fill({ color: "#e8edf6" }),
            stroke: new Stroke({ color: "rgba(8,12,20,0.9)", width: 3 }),
            textAlign: "center",
          }),
        }),
      );
      f.setStyle(styles);
    }

    // Drop stations that aged out of the snapshot.
    for (const [call, f] of stationFeats.current) {
      if (!seen.has(call)) {
        psrc.removeFeature(f);
        stationFeats.current.delete(call);
        const tf = stationTrailFeats.current.get(call);
        if (tf) {
          tsrc.removeFeature(tf);
          stationTrailFeats.current.delete(call);
        }
        stationTrails.current.delete(call);
      }
    }

    fitOnce(psrc);
  }, [stations, selected, settings.ageFade, settings.labelMode, zoom]);

  // Fit the view once to whichever layer first has positioned targets.
  function fitOnce(src: VectorSource) {
    if (didFit.current || src.getFeatures().length === 0) return;
    const extent = src.getExtent();
    if (extent && Number.isFinite(extent[0]!)) {
      mapRef.current
        ?.getView()
        .fit(extent, { padding: [70, 70, 70, 70], maxZoom: 11, duration: 400 });
      didFit.current = true;
    }
  }

  // Position the detail popup over the selected target.
  useEffect(() => {
    const ov = overlayRef.current;
    if (!ov) return;
    const t = selectedAircraft ?? selectedVessel ?? selectedStation;
    if (t?.lat != null && t.lon != null) {
      ov.setPosition(fromLonLat([t.lon, t.lat]));
    } else {
      ov.setPosition(undefined);
    }
  }, [selectedAircraft, selectedVessel, selectedStation]);

  const sel = selectedAircraft;
  const info = sel ? icaoInfo(sel.icao) : null;
  const target = selectedAircraft ?? selectedVessel ?? selectedStation;
  const dist =
    target?.lat != null && refLat != null && refLon != null
      ? distanceNm(refLat, refLon, target.lat, target.lon!)
      : null;
  const brg =
    target?.lat != null && refLat != null && refLon != null
      ? bearing(refLat, refLon, target.lat, target.lon!)
      : null;

  const targetHasPosition = target?.lat != null && target.lon != null;

  return (
    <div ref={rootRef} className="relative h-full w-full bg-background">
      <div ref={elRef} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-3">
        <div className="pointer-events-auto flex overflow-hidden rounded-md border bg-popover/95">
          <MapToolButton label="Zoom in" onClick={() => zoomBy(1)}>
            <Plus />
          </MapToolButton>
          <MapToolButton label="Zoom out" onClick={() => zoomBy(-1)}>
            <Minus />
          </MapToolButton>
          <MapToolButton label="Fit targets" onClick={fitVisibleTargets}>
            <Crosshair />
          </MapToolButton>
          <MapToolButton
            label="Center receiver"
            onClick={centerReceiver}
            disabled={refLat == null || refLon == null}
          >
            <LocateFixed />
          </MapToolButton>
          <MapToolButton
            label={followSelected ? "Stop following selected" : "Follow selected"}
            onClick={() => setFollowSelected((v) => !v)}
            disabled={!targetHasPosition}
            pressed={followSelected}
          >
            <LocateFixed />
          </MapToolButton>
          <MapToolButton
            label={fullscreen ? "Exit fullscreen" : "Fullscreen map"}
            onClick={toggleFullscreen}
            pressed={fullscreen}
          >
            <Maximize2 />
          </MapToolButton>
        </div>

        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <div className="flex items-center gap-1 rounded-md border bg-popover/95 p-1">
            <Select
              value={settings.basemap}
              onValueChange={(v) => setMapSettings({ basemap: v as BasemapId })}
            >
              <SelectTrigger className="h-7 w-32 border-0 bg-transparent px-2 font-mono text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {BASEMAPS.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon-sm"
              variant={settingsOpen ? "secondary" : "ghost"}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-expanded={settingsOpen}
              aria-label="Map settings"
              title="Map settings"
            >
              <Settings2 />
            </Button>
          </div>

          {settingsOpen && (
            <MapSettingsPanel settings={settings} onChange={setMapSettings} />
          )}
        </div>
      </div>

      {settings.legend && <MapLegend />}
      {settings.readouts && <MapReadouts cursor={cursor} zoom={zoom} />}

      <div
        ref={popupRef}
        className={`pointer-events-none w-52 -translate-x-1/2 rounded-md border bg-popover/95 p-2.5 text-[11px] shadow-sm backdrop-blur ${
          target ? "" : "hidden"
        }`}
      >
        {sel && (
          <>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-foreground">
                {sel.callsign?.trim() || info?.registration || sel.icao.toUpperCase()}
              </span>
              {info?.flag && <span className="text-sm">{info.flag}</span>}
            </div>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
              <Row k="ICAO" v={sel.icao.toUpperCase()} />
              {info?.registration && <Row k="Reg" v={info.registration} />}
              <Row k="Cat" v={categoryInfo(sel.category).label} />
              <Row k="Alt" v={sel.altitude != null ? `${sel.altitude.toLocaleString()} ft` : "—"} />
              <Row k="Spd" v={sel.speed != null ? `${sel.speed} kt` : "—"} />
              <Row k="Hdg" v={sel.heading != null ? `${sel.heading}°` : "—"} />
              <Row k="V/S" v={sel.vertRate != null ? `${sel.vertRate} fpm` : "—"} />
              {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
              {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
              <Row k="Sig" v={sel.rssi != null ? `${sel.rssi} dB` : "—"} />
            </dl>
          </>
        )}
        {!sel && selectedVessel && (
          <>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-foreground">
                {selectedVessel.name?.trim() || selectedVessel.mmsi}
              </span>
              {selectedVessel.channel && (
                <span className="text-[10px] text-muted-foreground">
                  ch {selectedVessel.channel}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
              <Row k="MMSI" v={selectedVessel.mmsi} />
              {selectedVessel.callsign && <Row k="Call" v={selectedVessel.callsign} />}
              <Row k="Type" v={selectedVessel.shipType ?? (selectedVessel.classB ? "Class B" : "—")} />
              <Row k="SOG" v={selectedVessel.sog != null ? `${selectedVessel.sog.toFixed(1)} kt` : "—"} />
              <Row k="COG" v={selectedVessel.cog != null ? `${selectedVessel.cog.toFixed(0)}°` : "—"} />
              <Row k="Hdg" v={selectedVessel.heading != null ? `${selectedVessel.heading}°` : "—"} />
              {selectedVessel.navStatus && <Row k="Status" v={selectedVessel.navStatus} />}
              {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
              {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
              <Row k="Sig" v={selectedVessel.rssi != null ? `${selectedVessel.rssi} dB` : "—"} />
            </dl>
          </>
        )}
        {!sel && !selectedVessel && selectedStation && (
          <>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-foreground">
                {selectedStation.call}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {aprsKindLabel(aprsKind(selectedStation.symbol))}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
              <Row
                k="Spd"
                v={selectedStation.speed != null ? `${selectedStation.speed} kt` : "—"}
              />
              <Row
                k="Crs"
                v={selectedStation.course != null ? `${selectedStation.course}°` : "—"}
              />
              <Row
                k="Alt"
                v={
                  selectedStation.altitude != null
                    ? `${selectedStation.altitude.toLocaleString()} ft`
                    : "—"
                }
              />
              {dist != null && <Row k="Dist" v={`${dist.toFixed(0)} NM`} />}
              {brg != null && <Row k="Brg" v={`${brg.toFixed(0)}°`} />}
            </dl>
            {selectedStation.via && (
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
                via {selectedStation.via}
              </div>
            )}
            {selectedStation.comment && (
              <div className="mt-1 text-[10px] text-foreground/75">
                {selectedStation.comment}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MapToolButton({
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

function MapSettingsPanel({
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

function MapLegend() {
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

function MapReadouts({
  cursor,
  zoom,
}: {
  cursor: { lat: number; lon: number; dist: number | null; brg: number | null } | null;
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{k}</dt>
      <dd className="text-right text-foreground/85">{v}</dd>
    </>
  );
}
