// Sub-audible tone signalling: the CTCSS tone table and the DCS codeword math,
// shared by the server's decoder and the client's selection UI.
//
// DCS (Digital-Coded Squelch) puts a 134.4 bps bitstream below the voice band:
// a 23-bit Golay(23,12) codeword repeated end to end. Transmitted LSB-first,
// the word is [9 code bits][fixed 0b100 signature][11 parity bits], so in our
// integer representation bit 0 is the first bit on air, the octal code sits in
// bits 0–8, the signature in bits 9–11 (reading 0b100, i.e. bit 11 set), and
// parity occupies bits 12–22. Because the code is cyclic and the word repeats,
// a receiver can lock onto rotated alignments that decode as *different* valid
// codes — so every detected code is mapped back to a canonical one, and codes
// that are mere rotations of an earlier code are excluded from the selectable
// list (this is why only ~83 of the 104 published codes are usable).
//
// Format reference: https://www.sigidwiki.com/wiki/Digital-Coded_Squelch_(DCS)
// Parity matrix and alignment-alias behaviour cross-checked against SDRangel's
// implementation (sdrbase/util/golay2312.cpp, dsp/dcscodes.cpp), itself derived
// from http://onfreq.com/syntorx/dcs.html.

/** Standard CTCSS tone set (Hz), the common 50-tone superset. */
export const CTCSS_TONES = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4,
  100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3,
  146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9,
  183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7,
  229.1, 233.6, 241.8, 250.3, 254.1,
] as const;

/** DCS bit rate on air (bits/s). */
export const DCS_BAUD = 134.4;

/** The 104 commonly published DCS codes (octal values as numbers). */
export const DCS_CODES: number[] = [
  0o023, 0o025, 0o026, 0o031, 0o032, 0o036, 0o043, 0o047, 0o051, 0o053,
  0o054, 0o065, 0o071, 0o072, 0o073, 0o074, 0o114, 0o115, 0o116, 0o122,
  0o125, 0o131, 0o132, 0o134, 0o143, 0o145, 0o152, 0o155, 0o156, 0o162,
  0o165, 0o172, 0o174, 0o205, 0o212, 0o223, 0o225, 0o226, 0o243, 0o244,
  0o245, 0o246, 0o251, 0o252, 0o255, 0o261, 0o263, 0o265, 0o266, 0o271,
  0o274, 0o306, 0o311, 0o315, 0o325, 0o331, 0o332, 0o343, 0o346, 0o351,
  0o356, 0o364, 0o365, 0o371, 0o411, 0o412, 0o413, 0o423, 0o431, 0o432,
  0o445, 0o446, 0o452, 0o454, 0o455, 0o462, 0o464, 0o465, 0o466, 0o503,
  0o506, 0o516, 0o523, 0o526, 0o532, 0o546, 0o565, 0o606, 0o612, 0o624,
  0o627, 0o631, 0o632, 0o654, 0o662, 0o664, 0o703, 0o712, 0o723, 0o731,
  0o732, 0o734, 0o743, 0o754,
];

// Golay(23,12) parity generator: parity bit r (placed at word bit 22-r) is the
// even parity of the data bits selected by row r. Data = bits 0–11 of the word.
const PARITY_ROWS = [
  0b101001001111, 0b111101101000, 0b011110110100, 0b001111011010,
  0b000111101101, 0b101010111001, 0b111100010011, 0b110111000110,
  0b011011100011, 0b100100111110, 0b010010011111,
];

function parity12(v: number): number {
  v ^= v >> 8;
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return v & 1;
}

/** Build the 23-bit on-air word for a DCS code (bit 0 = first bit on air). */
export function dcsEncodeWord(code: number): number {
  const data = 0b100_000000000 | (code & 0x1ff); // signature + code
  let word = data;
  for (let r = 0; r < 11; r++) {
    word |= parity12(PARITY_ROWS[r]! & data) << (22 - r);
  }
  return word;
}

/**
 * Validate a received 23-bit window: signature bits must read 0b100 and the
 * parity bits must match the data bits. Returns the raw 9-bit code, or null.
 */
export function dcsCheckWord(word: number): number | null {
  if (((word >> 9) & 0b111) !== 0b100) return null;
  return dcsEncodeWord(word & 0x1ff) === (word & 0x7fffff)
    ? word & 0x1ff
    : null;
}

/** Rotate a 23-bit word right by one (the on-air stream slid one bit). */
function rotr23(w: number): number {
  return ((w >> 1) | ((w & 1) << 22)) & 0x7fffff;
}

// A repeated codeword can validate at several rotations, each reading as a
// different raw code. Map every such reading back to the standard code whose
// stream produced it; standard codes that turn out to be rotations of an
// earlier standard code are dropped from the selectable list.
const CANONICAL = new Map<number, number>();
const SELECTABLE: number[] = [];
for (const code of DCS_CODES) {
  if (CANONICAL.has(code)) continue; // an alias of an earlier code
  SELECTABLE.push(code);
  let w = dcsEncodeWord(code);
  for (let r = 0; r < 23; r++) {
    const read = dcsCheckWord(w);
    if (read != null && !CANONICAL.has(read)) CANONICAL.set(read, code);
    w = rotr23(w);
  }
}

/** DCS codes offered for selection (standard codes minus rotation aliases). */
export const DCS_SELECTABLE: number[] = SELECTABLE;

/** Map a decoded raw code to its canonical standard code, or null. */
export function dcsCanonical(code: number): number | null {
  return CANONICAL.get(code) ?? null;
}

/** Conventional display name, e.g. dcsName(0o23, false) = "D023N". */
export function dcsName(code: number, inverted: boolean): string {
  return `D${code.toString(8).padStart(3, "0")}${inverted ? "I" : "N"}`;
}
