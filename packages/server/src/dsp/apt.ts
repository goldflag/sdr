// NOAA APT (Automatic Picture Transmission) receiver. The polar weather birds
// NOAA-15/18/19 broadcast a continuous analog image around 137 MHz: brightness
// amplitude-modulates a 2400 Hz subcarrier, which in turn frequency-modulates the
// ~34 kHz-wide downlink. The sensor scans 2 lines/sec at 4160 words/sec, so each
// line is 2080 pixels carrying two video channels (visible/IR) plus sync and
// telemetry.
//
// Pipeline:
//   NCO shift the carrier off the DC spike -> decimate 249.6 k -> 41.6 k
//   -> FM discriminator (recovers the 2400 Hz AM subcarrier audio)
//   -> quadrature product detector at 2400 Hz + low-pass -> envelope (video)
//   -> decimate 41.6 k -> 4160 px/s -> Channel-A sync correlation (line align)
//   -> auto-contrast to 8-bit -> emit one 2080-pixel scanline.
//
// We don't georeference: APT is just the raw raster as it arrives. A single
// dongle tunes one band, so APT (like ISM) takes over the receiver while active.

import { APT_SAMPLE_RATE, APT_IF_OFFSET, APT_PIXELS } from "@sdr/shared";
import { Nco } from "./nco";
import { ComplexDecimator, RealFir, designLowpass, tapsFor } from "./filters";

const DECIM1 = 6; // 249.6 kSPS -> 41.6 kHz FM audio
const AUDIO_RATE = APT_SAMPLE_RATE / DECIM1; // 41_600
const DECIM2 = 10; // 41.6 kHz -> 4160 pixels/sec
const PX_RATE = AUDIO_RATE / DECIM2; // 4160
const SUBCARRIER = 2400; // APT video subcarrier (Hz)
const LINE = APT_PIXELS; // 2080 pixels per scanline

// Sync A: 7 cycles of a 1040 Hz square wave at the start of every line. At 4160
// px/s that is 4 px/cycle (2 high, 2 low). A ±1 template makes the cross-
// correlation contrast-invariant (it sums to zero, so DC/brightness cancels).
const SYNC_CYCLES = 7;
const SYNC_LEN = SYNC_CYCLES * 4; // 28 pixels
const SYNC_LOCK = 0.45; // correlation/energy above this counts as a lock
const ALIGN_MARGIN = 40; // tracking search half-window once locked (px)

function buildSyncTemplate(): Float32Array {
  const t = new Float32Array(SYNC_LEN);
  for (let i = 0; i < SYNC_LEN; i++) t[i] = i % 4 < 2 ? 1 : -1;
  return t;
}

export interface AptLine {
  lineNo: number;
  pixels: Uint8Array;
  /** Sync-correlation lock quality for this line, 0..1. */
  sync: number;
}

export class AptReceiver {
  private nco = new Nco(APT_SAMPLE_RATE, -APT_IF_OFFSET);
  private decim = new ComplexDecimator(
    designLowpass(tapsFor(0.03), 0.085), // ~21 kHz cutoff @ 249.6 k (FM channel)
    DECIM1,
  );
  // Quadrature local oscillator at the 2400 Hz subcarrier (rotating phasor).
  private loCos = 1;
  private loSin = 0;
  private readonly loStepCos = Math.cos((2 * Math.PI * SUBCARRIER) / AUDIO_RATE);
  private readonly loStepSin = Math.sin((2 * Math.PI * SUBCARRIER) / AUDIO_RATE);
  private loN = 0;
  // Video I/Q low-pass (~2 kHz) before the magnitude envelope.
  private lpI = new RealFir(designLowpass(tapsFor(0.03), 0.047));
  private lpQ = new RealFir(designLowpass(tapsFor(0.03), 0.047));
  // FM discriminator state.
  private prevI = 0;
  private prevQ = 0;
  // Decimator phase for AUDIO -> PX.
  private pxPhase = 0;
  // Channel-A sync template + pixel accumulator.
  private readonly tmpl = buildSyncTemplate();
  private acc: number[] = [];
  private locked = false;
  private lineNo = 0;
  // Display auto-contrast (slow EMAs of per-line min/max) and quality metrics.
  private lo = 0;
  private hi = 1;
  private contrastInit = false;
  private syncEma = 0;
  private env = 0;

  constructor(private onLine: (line: AptLine) => void) {}

  /** Scanlines rendered so far this pass. */
  get lines(): number {
    return this.lineNo;
  }
  /** Recent line-sync lock quality (0..1); high means a satellite is locked. */
  get syncLevel(): number {
    return Math.round(this.syncEma * 100) / 100;
  }
  /** Channel signal level in dB (baseband envelope), an antenna-aim gauge. */
  get levelDb(): number {
    return Math.round(10 * Math.log10(Math.max(this.env, 1e-9)) * 10) / 10;
  }

  reset() {
    this.prevI = 0;
    this.prevQ = 0;
    this.loCos = 1;
    this.loSin = 0;
    this.loN = 0;
    this.pxPhase = 0;
    this.acc = [];
    this.locked = false;
    this.lineNo = 0;
    this.lo = 0;
    this.hi = 1;
    this.contrastInit = false;
    this.syncEma = 0;
    this.env = 0;
  }

  /** `iq` is interleaved complex at APT_SAMPLE_RATE. */
  process(iq: Float32Array) {
    const shifted = this.nco.mix(iq, new Float32Array(iq.length));
    const bb = this.decim.process(shifted); // interleaved complex @ 41.6 kHz
    const n = bb.length >> 1;

    // FM discriminator: phase difference between consecutive samples.
    const audio = new Float32Array(n);
    let pi = this.prevI;
    let pq = this.prevQ;
    for (let k = 0; k < n; k++) {
      const i = bb[2 * k]!;
      const q = bb[2 * k + 1]!;
      const re = i * pi + q * pq;
      const im = q * pi - i * pq;
      audio[k] = Math.atan2(im, re);
      const mag = i * i + q * q;
      this.env += 0.0005 * (mag - this.env);
      pi = i;
      pq = q;
    }
    this.prevI = pi;
    this.prevQ = pq;

    // Quadrature product-detect the 2400 Hz subcarrier: multiply by cos/sin,
    // low-pass each arm, then the magnitude is the (phase-invariant) video
    // envelope. Brightness rode the subcarrier amplitude.
    const dI = new Float32Array(n);
    const dQ = new Float32Array(n);
    let c = this.loCos;
    let s = this.loSin;
    const sc = this.loStepCos;
    const ss = this.loStepSin;
    for (let k = 0; k < n; k++) {
      const a = audio[k]!;
      dI[k] = a * c;
      dQ[k] = a * s;
      const nc = c * sc - s * ss;
      const ns = c * ss + s * sc;
      c = nc;
      s = ns;
      if ((this.loN++ & 0x3ff) === 0) {
        const m = Math.hypot(c, s) || 1;
        c /= m;
        s /= m;
      }
    }
    this.loCos = c;
    this.loSin = s;
    const vI = this.lpI.process(dI);
    const vQ = this.lpQ.process(dQ);

    // Decimate AUDIO -> PX, taking the envelope magnitude at each pixel instant.
    for (let k = this.pxPhase; k < n; k += DECIM2) {
      this.acc.push(Math.hypot(vI[k]!, vQ[k]!));
    }
    this.pxPhase = ((this.pxPhase - n) % DECIM2 + DECIM2) % DECIM2;

    this.emitLines();
  }

  // Find each line's Sync-A burst by cross-correlation and emit aligned rows.
  // Before lock we search a full line for the sync; once locked we only search a
  // small window around the expected start, which tracks slow clock drift and
  // rejects noise-driven false locks.
  private emitLines() {
    const tmpl = this.tmpl;
    while (true) {
      const searchHi = this.locked ? 2 * ALIGN_MARGIN : LINE;
      // Need a full line past the furthest search position to slice it.
      if (this.acc.length < LINE + searchHi + SYNC_LEN) break;

      let bestP = 0;
      let bestC = -Infinity;
      let bestEnergy = 1e-9;
      for (let p = 0; p <= searchHi; p++) {
        let corr = 0;
        let energy = 0;
        for (let j = 0; j < SYNC_LEN; j++) {
          const v = this.acc[p + j]!;
          corr += tmpl[j]! * v;
          energy += Math.abs(v);
        }
        if (corr > bestC) {
          bestC = corr;
          bestP = p;
          bestEnergy = energy;
        }
      }
      const strength = bestC / Math.max(bestEnergy, 1e-9); // 0..1
      this.locked = strength > SYNC_LOCK;
      this.syncEma += 0.1 * (Math.max(0, strength) - this.syncEma);

      this.renderLine(bestP, strength);

      // Consume up to the line end, leaving ALIGN_MARGIN of overlap so the next
      // line's sync lands near +ALIGN_MARGIN in the trimmed buffer.
      const consume = Math.max(1, bestP + LINE - ALIGN_MARGIN);
      this.acc.splice(0, consume);
    }
  }

  private renderLine(start: number, strength: number) {
    // Per-line min/max drive a slowly-adapting brightness map so the picture
    // holds steady contrast as the signal fades in and out over a pass.
    let mn = Infinity;
    let mx = -Infinity;
    for (let x = 0; x < LINE; x++) {
      const v = this.acc[start + x]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!this.contrastInit) {
      this.lo = mn;
      this.hi = mx;
      this.contrastInit = true;
    } else {
      this.lo += 0.05 * (mn - this.lo);
      this.hi += 0.05 * (mx - this.hi);
    }
    const span = Math.max(this.hi - this.lo, 1e-6);

    const pixels = new Uint8Array(LINE);
    for (let x = 0; x < LINE; x++) {
      const t = (this.acc[start + x]! - this.lo) / span;
      pixels[x] = t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0;
    }
    this.onLine({
      lineNo: this.lineNo++,
      pixels,
      sync: Math.round(Math.max(0, strength) * 100) / 100,
    });
  }
}
