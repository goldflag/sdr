// Representative band plans for several regions, used to label frequency
// allocations on the spectrum/waterfall. These are deliberately simplified for
// orientation: they cover the segments an RTL-SDR user commonly tunes
// (broadcast, amateur, air, marine, weather, ISM) rather than every
// sub-allocation, and real national regulations vary in the details.
//
// A plan is a flat list of segments; the spectrum component maps each segment's
// start/end frequency to pixels and shades + labels it by category. Segments
// are sorted widest-first at build time so that narrow, specific bands (e.g. an
// ISM pocket inside an amateur band) paint their strip and label on top.

export type BandCategory =
  | "broadcast"
  | "amateur"
  | "aviation"
  | "marine"
  | "weather"
  | "business"
  | "ism"
  | "satellite";

export interface BandSegment {
  name: string;
  startHz: number;
  endHz: number;
  category: BandCategory;
}

export interface BandPlan {
  /** Stable id stored in display settings. */
  code: string;
  label: string;
  segments: BandSegment[];
}

/** Strip/tint colour per category (also valid CSS for the sidebar legend). */
export const CATEGORY_COLOR: Record<BandCategory, string> = {
  broadcast: "oklch(0.72 0.18 25)", // red-orange
  amateur: "oklch(0.80 0.16 150)", // green
  aviation: "oklch(0.74 0.15 250)", // blue
  marine: "oklch(0.78 0.12 200)", // cyan
  weather: "oklch(0.82 0.16 95)", // yellow-green
  business: "oklch(0.74 0.16 330)", // magenta
  ism: "oklch(0.80 0.14 60)", // amber
  satellite: "oklch(0.72 0.13 300)", // violet
};

export const CATEGORY_LABEL: Record<BandCategory, string> = {
  broadcast: "Broadcast",
  amateur: "Amateur",
  aviation: "Aviation",
  marine: "Marine",
  weather: "Weather",
  business: "Business / PMR",
  ism: "ISM",
  satellite: "Satellite",
};

const seg = (
  name: string,
  startHz: number,
  endHz: number,
  category: BandCategory,
): BandSegment => ({ name, startHz, endHz, category });

// --- globally harmonised segments (shared across plans) ---------------------

const AVIATION: BandSegment[] = [
  seg("VOR / ILS", 108_000_000, 117_975_000, "aviation"),
  seg("Airband", 118_000_000, 136_975_000, "aviation"),
];

const MARINE: BandSegment[] = [seg("Marine VHF", 156_000_000, 162_025_000, "marine")];

const WX_SAT: BandSegment[] = [seg("Wx satellites", 137_000_000, 138_000_000, "satellite")];

const COMMON = [...AVIATION, ...MARINE, ...WX_SAT];

// --- amateur allocations (HF edges differ a little by ITU region) -----------

const AMATEUR_US: BandSegment[] = [
  seg("160 m", 1_800_000, 2_000_000, "amateur"),
  seg("80 m", 3_500_000, 4_000_000, "amateur"),
  seg("60 m", 5_330_500, 5_406_500, "amateur"),
  seg("40 m", 7_000_000, 7_300_000, "amateur"),
  seg("30 m", 10_100_000, 10_150_000, "amateur"),
  seg("20 m", 14_000_000, 14_350_000, "amateur"),
  seg("17 m", 18_068_000, 18_168_000, "amateur"),
  seg("15 m", 21_000_000, 21_450_000, "amateur"),
  seg("12 m", 24_890_000, 24_990_000, "amateur"),
  seg("10 m", 28_000_000, 29_700_000, "amateur"),
  seg("6 m", 50_000_000, 54_000_000, "amateur"),
  seg("2 m", 144_000_000, 148_000_000, "amateur"),
  seg("1.25 m", 222_000_000, 225_000_000, "amateur"),
  seg("70 cm", 420_000_000, 450_000_000, "amateur"),
  seg("33 cm", 902_000_000, 928_000_000, "amateur"),
  seg("23 cm", 1_240_000_000, 1_300_000_000, "amateur"),
];

const AMATEUR_R1: BandSegment[] = [
  seg("160 m", 1_810_000, 2_000_000, "amateur"),
  seg("80 m", 3_500_000, 3_800_000, "amateur"),
  seg("40 m", 7_000_000, 7_200_000, "amateur"),
  seg("30 m", 10_100_000, 10_150_000, "amateur"),
  seg("20 m", 14_000_000, 14_350_000, "amateur"),
  seg("17 m", 18_068_000, 18_168_000, "amateur"),
  seg("15 m", 21_000_000, 21_450_000, "amateur"),
  seg("12 m", 24_890_000, 24_990_000, "amateur"),
  seg("10 m", 28_000_000, 29_700_000, "amateur"),
  seg("6 m", 50_000_000, 52_000_000, "amateur"),
  seg("2 m", 144_000_000, 146_000_000, "amateur"),
  seg("70 cm", 430_000_000, 440_000_000, "amateur"),
  seg("23 cm", 1_240_000_000, 1_300_000_000, "amateur"),
];

const AMATEUR_UK: BandSegment[] = [
  ...AMATEUR_R1,
  seg("4 m", 70_000_000, 70_500_000, "amateur"),
];

const AMATEUR_JP: BandSegment[] = [
  seg("160 m", 1_800_000, 1_875_000, "amateur"),
  seg("80 m", 3_500_000, 3_805_000, "amateur"),
  seg("40 m", 7_000_000, 7_200_000, "amateur"),
  seg("30 m", 10_100_000, 10_150_000, "amateur"),
  seg("20 m", 14_000_000, 14_350_000, "amateur"),
  seg("15 m", 21_000_000, 21_450_000, "amateur"),
  seg("10 m", 28_000_000, 29_700_000, "amateur"),
  seg("6 m", 50_000_000, 54_000_000, "amateur"),
  seg("2 m", 144_000_000, 146_000_000, "amateur"),
  seg("70 cm", 430_000_000, 440_000_000, "amateur"),
];

const AMATEUR_AU: BandSegment[] = [
  seg("160 m", 1_800_000, 1_875_000, "amateur"),
  seg("80 m", 3_500_000, 3_700_000, "amateur"),
  seg("40 m", 7_000_000, 7_300_000, "amateur"),
  seg("30 m", 10_100_000, 10_150_000, "amateur"),
  seg("20 m", 14_000_000, 14_350_000, "amateur"),
  seg("17 m", 18_068_000, 18_168_000, "amateur"),
  seg("15 m", 21_000_000, 21_450_000, "amateur"),
  seg("12 m", 24_890_000, 24_990_000, "amateur"),
  seg("10 m", 28_000_000, 29_700_000, "amateur"),
  seg("6 m", 50_000_000, 54_000_000, "amateur"),
  seg("2 m", 144_000_000, 148_000_000, "amateur"),
  seg("70 cm", 420_000_000, 450_000_000, "amateur"),
  seg("23 cm", 1_240_000_000, 1_300_000_000, "amateur"),
];

// --- region-specific broadcast / personal-radio / ISM -----------------------

const US_EXTRA: BandSegment[] = [
  seg("MW / AM", 530_000, 1_700_000, "broadcast"),
  seg("FM", 88_000_000, 108_000_000, "broadcast"),
  seg("NOAA Wx", 162_400_000, 162_550_000, "weather"),
  seg("FRS / GMRS", 462_550_000, 462_725_000, "business"),
  seg("ISM 915", 902_000_000, 928_000_000, "ism"),
  seg("ISM 2.4 GHz", 2_400_000_000, 2_483_500_000, "ism"),
];

const EU_EXTRA: BandSegment[] = [
  seg("Long wave", 148_500, 283_500, "broadcast"),
  seg("MW / AM", 526_500, 1_606_500, "broadcast"),
  seg("FM", 87_500_000, 108_000_000, "broadcast"),
  seg("DAB (Band III)", 174_000_000, 240_000_000, "broadcast"),
  seg("PMR446", 446_000_000, 446_200_000, "business"),
  seg("ISM 433", 433_050_000, 434_790_000, "ism"),
  seg("ISM 868", 863_000_000, 870_000_000, "ism"),
  seg("ISM 2.4 GHz", 2_400_000_000, 2_483_500_000, "ism"),
];

const JP_EXTRA: BandSegment[] = [
  seg("MW / AM", 526_500, 1_606_500, "broadcast"),
  seg("FM", 76_000_000, 95_000_000, "broadcast"), // distinctive 76–95 MHz band
  seg("ISM 920", 915_900_000, 929_700_000, "ism"),
  seg("ISM 2.4 GHz", 2_400_000_000, 2_497_000_000, "ism"),
];

const AU_EXTRA: BandSegment[] = [
  seg("MW / AM", 531_000, 1_701_000, "broadcast"),
  seg("FM", 87_500_000, 108_000_000, "broadcast"),
  seg("DAB+ (Band III)", 174_000_000, 230_000_000, "broadcast"),
  seg("UHF CB", 476_425_000, 477_413_000, "business"),
  seg("ISM 915", 915_000_000, 928_000_000, "ism"),
  seg("ISM 2.4 GHz", 2_400_000_000, 2_483_500_000, "ism"),
];

// Widest-first so narrow, specific bands sit on top when they overlap a wide one.
const byWidthDesc = (segments: BandSegment[]): BandSegment[] =>
  [...segments].sort(
    (a, b) => b.endHz - b.startHz - (a.endHz - a.startHz),
  );

function plan(code: string, label: string, parts: BandSegment[][]): BandPlan {
  return { code, label, segments: byWidthDesc(parts.flat()) };
}

export const BAND_PLANS: BandPlan[] = [
  plan("US", "United States", [US_EXTRA, AMATEUR_US, COMMON]),
  plan("EU", "Europe (ITU R1)", [EU_EXTRA, AMATEUR_R1, COMMON]),
  plan("UK", "United Kingdom", [EU_EXTRA, AMATEUR_UK, COMMON]),
  plan("JP", "Japan", [JP_EXTRA, AMATEUR_JP, COMMON]),
  plan("AU", "Australia", [AU_EXTRA, AMATEUR_AU, COMMON]),
];

/** Segments for a plan code, or null for "off" / an unknown code. */
export function bandPlanSegments(code: string): BandSegment[] | null {
  return BAND_PLANS.find((p) => p.code === code)?.segments ?? null;
}
