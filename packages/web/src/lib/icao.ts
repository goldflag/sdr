// Offline aircraft "database" derived purely from the 24-bit ICAO address — no
// bundled data file. We resolve:
//   • registering country (from ICAO allocation blocks) + flag emoji
//   • US registration / tail number (algorithmic, exact for the N-number block)
//   • a coarse aircraft kind from the ADS-B emitter category (for map icons)
//
// Country coverage is a curated set of the large national blocks (these account
// for the overwhelming majority of traffic); unlisted addresses return no
// country rather than a guessed one.

interface Block {
  lo: number;
  hi: number;
  iso2: string;
  name: string;
}

// High-confidence large allocation blocks.
const BLOCKS: Block[] = [
  { lo: 0xa00000, hi: 0xafffff, iso2: "US", name: "United States" },
  { lo: 0xc00000, hi: 0xc3ffff, iso2: "CA", name: "Canada" },
  { lo: 0x140000, hi: 0x1fffff, iso2: "RU", name: "Russia" },
  { lo: 0x780000, hi: 0x7bffff, iso2: "CN", name: "China" },
  { lo: 0x840000, hi: 0x87ffff, iso2: "JP", name: "Japan" },
  { lo: 0x718000, hi: 0x71ffff, iso2: "KR", name: "South Korea" },
  { lo: 0x800000, hi: 0x83ffff, iso2: "IN", name: "India" },
  { lo: 0x7c0000, hi: 0x7fffff, iso2: "AU", name: "Australia" },
  { lo: 0xe40000, hi: 0xe7ffff, iso2: "BR", name: "Brazil" },
  { lo: 0x3c0000, hi: 0x3fffff, iso2: "DE", name: "Germany" },
  { lo: 0x380000, hi: 0x3bffff, iso2: "FR", name: "France" },
  { lo: 0x400000, hi: 0x43ffff, iso2: "GB", name: "United Kingdom" },
  { lo: 0x340000, hi: 0x37ffff, iso2: "ES", name: "Spain" },
  { lo: 0x300000, hi: 0x33ffff, iso2: "IT", name: "Italy" },
];

export interface IcaoInfo {
  country?: string;
  flag?: string;
  registration?: string;
}

const cache = new Map<string, IcaoInfo>();

export function icaoInfo(hex: string): IcaoInfo {
  const cached = cache.get(hex);
  if (cached) return cached;
  const n = parseInt(hex, 16);
  const info: IcaoInfo = {};
  for (const b of BLOCKS) {
    if (n >= b.lo && n <= b.hi) {
      info.country = b.name;
      info.flag = iso2ToFlag(b.iso2);
      break;
    }
  }
  const reg = usRegistration(n);
  if (reg) info.registration = reg;
  cache.set(hex, info);
  return info;
}

/** 2-letter country code -> regional-indicator flag emoji. */
export function iso2ToFlag(iso2: string): string {
  return String.fromCodePoint(
    ...[...iso2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// US N-number (tail) from ICAO address, for the 0xA00001–0xADF7C7 block. This
// is the exact inverse of the FAA's deterministic encoding.
const NLETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24 letters, no I or O

function suffix(rem: number): string {
  if (rem === 0) return "";
  // The FAA suffix space is interleaved, not two flat blocks: each first letter
  // owns 25 codes — the single letter itself (offset 0) followed by its 24
  // two-letter children (offsets 1..24). So "" , A, AA, AB … AZ, B, BA …, ZZ.
  rem -= 1;
  const first = NLETTERS[Math.floor(rem / 25)]!;
  const second = rem % 25;
  return second === 0 ? first : first + NLETTERS[second - 1]!;
}

export function usRegistration(icao: number): string | null {
  if (icao < 0xa00001 || icao > 0xadf7c7) return null;
  let i = icao - 0xa00001;
  let reg = "N";

  reg += Math.floor(i / 101711) + 1; // first digit 1-9
  i %= 101711;
  if (i < 601) return reg + suffix(i);
  i -= 601;

  reg += Math.floor(i / 10111); // second digit 0-9
  i %= 10111;
  if (i < 601) return reg + suffix(i);
  i -= 601;

  reg += Math.floor(i / 951); // third digit 0-9
  i %= 951;
  if (i < 601) return reg + suffix(i);
  i -= 601;

  reg += Math.floor(i / 35); // fourth digit 0-9
  i %= 35;
  if (i < 25) return reg + (i === 0 ? "" : NLETTERS[i - 1]!);
  i -= 25;

  return reg + i; // fifth digit 0-9
}

// --- emitter category ------------------------------------------------------

export type AircraftKind = "plane" | "heavy" | "light" | "heli" | "ground";

interface CategoryInfo {
  label: string;
  kind: AircraftKind;
}

const CATEGORIES: Record<string, CategoryInfo> = {
  A1: { label: "Light", kind: "light" },
  A2: { label: "Small", kind: "plane" },
  A3: { label: "Large", kind: "plane" },
  A4: { label: "High-vortex large", kind: "heavy" },
  A5: { label: "Heavy", kind: "heavy" },
  A6: { label: "High performance", kind: "plane" },
  A7: { label: "Rotorcraft", kind: "heli" },
  B1: { label: "Glider", kind: "light" },
  B2: { label: "Lighter-than-air", kind: "light" },
  B3: { label: "Parachutist", kind: "light" },
  B4: { label: "Ultralight", kind: "light" },
  B6: { label: "UAV", kind: "light" },
  B7: { label: "Space vehicle", kind: "plane" },
  C1: { label: "Surface — emergency", kind: "ground" },
  C2: { label: "Surface — service", kind: "ground" },
  C3: { label: "Obstacle", kind: "ground" },
};

export function categoryInfo(code?: string): CategoryInfo {
  return (code && CATEGORIES[code]) || { label: "Aircraft", kind: "plane" };
}
