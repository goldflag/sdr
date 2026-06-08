// Live ADS-B map. Renders each tracked aircraft (those with a decoded position)
// as a heading-rotated plane marker on an OpenLayers/OSM map, updating in place
// as new snapshots arrive. Aircraft are keyed by ICAO so markers move rather
// than flicker. The view auto-fits to traffic once, then stays under user control.

import { useEffect, useRef } from "react";
import type { AircraftReport } from "@sdr/shared";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { fromLonLat } from "ol/proj";
import { Icon, Style, Text, Fill, Stroke } from "ol/style";
import "ol/ol.css";

interface Props {
  aircraft: AircraftReport[];
}

// Airplane silhouette pointing north (heading 0); OL rotates it clockwise.
const PLANE_SVG = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24">` +
  `<path d="M12 2 L12.9 9 L21 14 L21 15.8 L12.9 13 L12.9 19 L15.5 20.8 L15.5 22 L12 20.9 L8.5 22 L8.5 20.8 L11.1 19 L11.1 13 L3 15.8 L3 14 L11.1 9 Z" ` +
  `fill="${color}" stroke="#0b0f1a" stroke-width="0.8" stroke-linejoin="round"/></svg>`;

const svgUrl = (color: string) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(PLANE_SVG(color));

// Altitude → color ramp (low = teal, high = warm), echoing the spectrum palette.
function altColor(alt?: number): string {
  if (alt == null) return "#9ca3af";
  const t = Math.min(1, Math.max(0, alt / 40000));
  const stops: [number, string][] = [
    [0, "#22d3ee"],
    [0.5, "#34d399"],
    [0.8, "#fbbf24"],
    [1, "#f87171"],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i]![0]) return stops[i]![1];
  }
  return "#f87171";
}

function label(a: AircraftReport): string {
  const id = a.callsign?.trim() || a.icao.toUpperCase();
  const alt = a.altitude != null ? `${Math.round(a.altitude / 100) * 100} ft` : "";
  return alt ? `${id}\n${alt}` : id;
}

export function AdsbMap({ aircraft }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const sourceRef = useRef<VectorSource | null>(null);
  const featuresRef = useRef(new Map<string, Feature>());
  const didFit = useRef(false);

  // One-time map setup.
  useEffect(() => {
    if (!elRef.current) return;
    const source = new VectorSource();
    sourceRef.current = source;
    const map = new OLMap({
      target: elRef.current,
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({ source }),
      ],
      view: new View({ center: fromLonLat([-98, 39]), zoom: 4 }),
      controls: [],
    });
    mapRef.current = map;
    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

  // Sync features with the latest aircraft snapshot.
  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    const feats = featuresRef.current;
    const seen = new Set<string>();

    for (const a of aircraft) {
      if (a.lat == null || a.lon == null) continue;
      seen.add(a.icao);
      const coord = fromLonLat([a.lon, a.lat]);
      let f = feats.get(a.icao);
      if (!f) {
        f = new Feature({ geometry: new Point(coord) });
        feats.set(a.icao, f);
        source.addFeature(f);
      } else {
        (f.getGeometry() as Point).setCoordinates(coord);
      }
      f.setStyle(
        new Style({
          image: new Icon({
            src: svgUrl(altColor(a.altitude)),
            rotation: ((a.heading ?? 0) * Math.PI) / 180,
            rotateWithView: true,
          }),
          text: new Text({
            text: label(a),
            offsetY: 26,
            font: "600 11px ui-monospace, Menlo, monospace",
            fill: new Fill({ color: "#0b0f1a" }),
            stroke: new Stroke({ color: "rgba(255,255,255,0.85)", width: 3 }),
            textAlign: "center",
          }),
        }),
      );
    }

    // Drop aircraft that aged out of the snapshot.
    for (const [icao, f] of feats) {
      if (!seen.has(icao)) {
        source.removeFeature(f);
        feats.delete(icao);
      }
    }

    // Fit the view to traffic the first time we have positions.
    if (!didFit.current && feats.size > 0) {
      const extent = source.getExtent();
      if (extent && Number.isFinite(extent[0]!)) {
        mapRef.current
          ?.getView()
          .fit(extent, { padding: [60, 60, 60, 60], maxZoom: 10, duration: 400 });
        didFit.current = true;
      }
    }
  }, [aircraft]);

  return <div ref={elRef} className="h-full w-full" />;
}
