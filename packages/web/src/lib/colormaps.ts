// Waterfall colormaps. Each is a small list of [pos, r, g, b] stops; we bake a
// 256-entry lookup table per map so the per-pixel hot path is a single index.

export type ColormapName =
  | "Aqua"
  | "Viridis"
  | "Inferno"
  | "Turbo"
  | "Grayscale";

export const COLORMAP_NAMES: ColormapName[] = [
  "Aqua",
  "Viridis",
  "Inferno",
  "Turbo",
  "Grayscale",
];

type Stop = [number, number, number, number]; // pos 0..1, r, g, b

const STOPS: Record<ColormapName, Stop[]> = {
  // The original house map: noise floor blends into the dark screen.
  Aqua: [
    [0.0, 10, 12, 24],
    [0.28, 26, 58, 132],
    [0.52, 28, 150, 140],
    [0.7, 70, 200, 120],
    [0.85, 232, 196, 70],
    [1.0, 240, 70, 50],
  ],
  Viridis: [
    [0.0, 68, 1, 84],
    [0.25, 59, 82, 139],
    [0.5, 33, 145, 140],
    [0.75, 94, 201, 98],
    [1.0, 253, 231, 37],
  ],
  Inferno: [
    [0.0, 0, 0, 4],
    [0.25, 87, 16, 110],
    [0.5, 188, 55, 84],
    [0.75, 249, 142, 9],
    [1.0, 252, 255, 164],
  ],
  Turbo: [
    [0.0, 48, 18, 59],
    [0.2, 54, 125, 197],
    [0.4, 43, 200, 142],
    [0.6, 175, 221, 38],
    [0.8, 249, 148, 40],
    [1.0, 122, 4, 3],
  ],
  Grayscale: [
    [0.0, 8, 8, 12],
    [1.0, 255, 255, 255],
  ],
};

function interp(stops: Stop[], t: number): [number, number, number] {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i]![0]) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      return [
        (a[1] + f * (b[1] - a[1])) | 0,
        (a[2] + f * (b[2] - a[2])) | 0,
        (a[3] + f * (b[3] - a[3])) | 0,
      ];
    }
  }
  const last = stops[stops.length - 1]!;
  return [last[1], last[2], last[3]];
}

const lutCache = new Map<ColormapName, Uint8ClampedArray>();

/** 256×3 RGB lookup table for a colormap (built once, then cached). */
export function colormapLut(name: ColormapName): Uint8ClampedArray {
  let lut = lutCache.get(name);
  if (lut) return lut;
  const stops = STOPS[name] ?? STOPS.Aqua;
  lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = interp(stops, i / 255);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  lutCache.set(name, lut);
  return lut;
}

/** CSS `linear-gradient(...)` for a colormap, for legends/previews. */
export function colormapGradient(name: ColormapName, steps = 12): string {
  const stops = STOPS[name] ?? STOPS.Aqua;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [r, g, b] = interp(stops, t);
    parts.push(`rgb(${r} ${g} ${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
