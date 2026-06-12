// SVG marker icons for the live map — aircraft (category-shaped), vessels
// (stylised hull), and APRS stations (a glyph per symbol kind) — plus the
// colour scales used to paint them. Building a fresh Icon per update is cheap:
// OpenLayers caches the decoded image by src, so only rotation/opacity vary
// per target.

import { Icon } from "ol/style";
import type { AircraftKind } from "@/lib/icao";
import type { AprsKind } from "@/lib/aprs";

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

export function icon(
  kind: AircraftKind,
  color: string,
  rotation: number,
  opacity: number,
) {
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

export function shipIcon(color: string, rotation: number, opacity: number) {
  return new Icon({ src: shipSvg(color), rotation, opacity, rotateWithView: true });
}

/** Colour a vessel by speed over ground: stationary → slate, fast → warm. */
export function vesselColor(sog?: number): string {
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

export function aprsIcon(
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

/** Colour an aircraft by barometric altitude: low → cyan, cruise → red. */
export function altColor(alt?: number): string {
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
