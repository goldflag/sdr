// Live ADS-B / AIS map. Renders each positioned aircraft (category-shaped,
// heading-rotated, altitude-colored) and vessel (heading-rotated ship marker)
// on a dark OpenLayers/OSM map, with fading by age, trails, an optional receiver
// marker + range rings, a click-to-select detail popup, and table<->map
// selection linking.

import { useEffect, useMemo, useRef } from "react";
import type { AircraftReport, VesselReport } from "@sdr/shared";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Overlay from "ol/Overlay";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import { circular } from "ol/geom/Polygon";
import { fromLonLat } from "ol/proj";
import {
  Icon,
  Style,
  Text,
  Fill,
  Stroke,
  Circle as CircleStyle,
} from "ol/style";
import { categoryInfo, icaoInfo, type AircraftKind } from "@/lib/icao";
import { distanceNm, bearing } from "@/lib/geo";
import "ol/ol.css";

interface Props {
  aircraft?: AircraftReport[];
  vessels?: VesselReport[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  refLat: number | null;
  refLon: number | null;
}

const MAX_TRAIL = 60; // points kept per aircraft trail
const STALE_S = 60;

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

function vesselLabel(v: VesselReport): string {
  const id = v.name?.trim() || v.mmsi;
  return v.sog != null && v.sog >= 0.5 ? `${id}\n${v.sog.toFixed(1)} kt` : id;
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

function label(a: AircraftReport): string {
  const id =
    a.callsign?.trim() || icaoInfo(a.icao).registration || a.icao.toUpperCase();
  const alt = a.altitude != null ? `${Math.round(a.altitude / 100) * 100}ft` : "";
  return alt ? `${id}\n${alt}` : id;
}

export function AdsbMap({
  aircraft = [],
  vessels = [],
  selected,
  onSelect,
  refLat,
  refLon,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const planeSrc = useRef<VectorSource | null>(null);
  const trailSrc = useRef<VectorSource | null>(null);
  const rangeSrc = useRef<VectorSource | null>(null);
  const shipSrc = useRef<VectorSource | null>(null);
  const shipTrailSrc = useRef<VectorSource | null>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const planeFeats = useRef(new Map<string, Feature>());
  const trailFeats = useRef(new Map<string, Feature>());
  const trails = useRef(new Map<string, number[][]>());
  const shipFeats = useRef(new Map<string, Feature>());
  const shipTrailFeats = useRef(new Map<string, Feature>());
  const shipTrails = useRef(new Map<string, number[][]>());
  const didFit = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const selectedAircraft = useMemo(
    () => aircraft.find((a) => a.icao === selected) ?? null,
    [aircraft, selected],
  );
  const selectedVessel = useMemo(
    () => vessels.find((v) => v.mmsi === selected) ?? null,
    [vessels, selected],
  );

  // One-time map setup.
  useEffect(() => {
    if (!elRef.current) return;
    const planes = new VectorSource();
    const trailV = new VectorSource();
    const range = new VectorSource();
    const ships = new VectorSource();
    const shipTrailV = new VectorSource();
    planeSrc.current = planes;
    trailSrc.current = trailV;
    rangeSrc.current = range;
    shipSrc.current = ships;
    shipTrailSrc.current = shipTrailV;

    const map = new OLMap({
      target: elRef.current,
      layers: [
        // Dark basemap: its own canvas (className) so the CSS filter doesn't
        // touch the vector overlays.
        new TileLayer({ source: new OSM(), className: "ol-basemap-dark" }),
        new VectorLayer({ source: range }),
        new VectorLayer({ source: trailV }),
        new VectorLayer({ source: shipTrailV }),
        new VectorLayer({ source: ships }),
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
          const id = f.get("icao") ?? f.get("mmsi");
          if (id) {
            hit = id;
            return true;
          }
        },
        { hitTolerance: 6 },
      );
      onSelectRef.current(hit);
    });

    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

  // Receiver marker + range rings.
  useEffect(() => {
    const src = rangeSrc.current;
    if (!src) return;
    src.clear();
    if (refLat == null || refLon == null) return;
    const center = [refLon, refLat];
    for (const nm of [50, 100, 150, 200]) {
      const ring = new Feature(circular(center, nm * 1852, 96).transform("EPSG:4326", "EPSG:3857"));
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
  }, [refLat, refLon]);

  // Sync aircraft markers + trails with the latest snapshot.
  useEffect(() => {
    const psrc = planeSrc.current;
    const tsrc = trailSrc.current;
    if (!psrc || !tsrc) return;
    const seen = new Set<string>();

    for (const a of aircraft) {
      if (a.lat == null || a.lon == null) continue;
      seen.add(a.icao);
      const coord = fromLonLat([a.lon, a.lat]);
      const color = altColor(a.altitude);
      const { kind } = categoryInfo(a.category);
      const opacity = Math.max(0.35, 1 - a.seen / STALE_S);
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
      } else {
        (f.getGeometry() as Point).setCoordinates(coord);
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
            text: label(a),
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
        const tf = trailFeats.current.get(icao);
        if (tf) {
          tsrc.removeFeature(tf);
          trailFeats.current.delete(icao);
        }
        trails.current.delete(icao);
      }
    }

    fitOnce(psrc);
  }, [aircraft, selected]);

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
      const opacity = Math.max(0.4, 1 - v.seen / STALE_S);
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
            text: vesselLabel(v),
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
  }, [vessels, selected]);

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
    const t = selectedAircraft ?? selectedVessel;
    if (t?.lat != null && t.lon != null) {
      ov.setPosition(fromLonLat([t.lon, t.lat]));
    } else {
      ov.setPosition(undefined);
    }
  }, [selectedAircraft, selectedVessel]);

  const sel = selectedAircraft;
  const info = sel ? icaoInfo(sel.icao) : null;
  const target = selectedAircraft ?? selectedVessel;
  const dist =
    target?.lat != null && refLat != null && refLon != null
      ? distanceNm(refLat, refLon, target.lat, target.lon!)
      : null;
  const brg =
    target?.lat != null && refLat != null && refLon != null
      ? bearing(refLat, refLon, target.lat, target.lon!)
      : null;

  return (
    <div className="relative h-full w-full">
      <div ref={elRef} className="h-full w-full" />
      <div
        ref={popupRef}
        className={`pointer-events-none w-52 -translate-x-1/2 rounded-md border bg-popover/95 p-2.5 text-[11px] shadow-lg backdrop-blur ${
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
      </div>
    </div>
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
