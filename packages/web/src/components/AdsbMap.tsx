// Live ADS-B / AIS map. Renders each positioned aircraft (category-shaped,
// heading-rotated, altitude-colored) and vessel (heading-rotated ship marker)
// on a dark OpenLayers/OSM map, with fading by age, trails, an optional receiver
// marker + range rings, a click-to-select detail popup, and table<->map
// selection linking. Icons live in lib/map-icons, dead-reckoning in lib/motion,
// settings/persistence in lib/map-settings, and the chrome in MapChrome.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AircraftReport,
  StationReport,
  VesselReport,
} from "@sdr/shared";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CursorReadout,
  MapLegend,
  MapReadouts,
  MapSettingsPanel,
  MapToolButton,
  TargetPopup,
} from "@/components/MapChrome";
import { categoryInfo } from "@/lib/icao";
import { aprsKind, aprsColor, aprsRotates } from "@/lib/aprs";
import {
  aircraftLabel,
  opacityForAge,
  stationMapLabel,
  vesselMapLabel,
} from "@/lib/map-labels";
import { altColor, aprsIcon, icon, shipIcon, vesselColor } from "@/lib/map-icons";
import {
  type MotionState,
  MAX_EXTRAPOLATE_S,
  MOTION_CORRECT_MS,
  motionCoord,
  predictLonLat,
} from "@/lib/motion";
import {
  type BasemapId,
  type MapSettings,
  BASEMAPS,
  loadMapSettings,
  saveMapSettings,
} from "@/lib/map-settings";
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
  const [cursor, setCursor] = useState<CursorReadout | null>(null);

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
        <TargetPopup
          aircraft={selectedAircraft}
          vessel={selectedVessel}
          station={selectedStation}
          dist={dist}
          brg={brg}
        />
      </div>
    </div>
  );
}
