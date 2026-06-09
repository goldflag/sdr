// Spectrum plot (top) + scrolling waterfall (bottom) sharing one frequency axis.
// Pulls the latest FFT frame via subscription and redraws on an rAF loop (no
// React re-render per frame). Click/drag tunes the VFO; wheel fine-tunes.
//
// Colors come from the spectrum data palette in index.css (--trace, --vfo, …),
// resolved once on mount so the canvas stays in step with the theme.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { FftFrame, RadioState } from "@sdr/shared";
import { formatHz } from "@/lib/utils";

interface Props {
  subscribeFft: (cb: (f: FftFrame) => void) => () => void;
  state: RadioState;
  onTune: (offsetHz: number) => void;
  onPassband: (low: number, high: number) => void;
  onNotches: (notches: number[]) => void;
}

const EDGE_GRAB_PX = 7; // pointer distance to grab a filter edge
const NOTCH_GRAB_PX = 7; // pointer distance to remove a notch

const SPECTRUM_H = 168;

interface Palette {
  screen: string;
  grid: string;
  trace: string;
  traceFill: string;
  vfo: string;
  vfoFill: string;
  axis: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    screen: v("--screen") || "oklch(0.16 0.004 277)",
    grid: v("--screen-grid") || "oklch(1 0 0 / 7%)",
    trace: v("--trace") || "oklch(0.82 0.17 162)",
    traceFill: v("--trace-fill") || "oklch(0.82 0.17 162 / 16%)",
    vfo: v("--vfo") || "oklch(0.74 0.16 282)",
    vfoFill: v("--vfo-fill") || "oklch(0.74 0.16 282 / 12%)",
    axis: "oklch(0.7 0 0 / 65%)",
  };
}

export function SpectrumWaterfall({
  subscribeFft,
  state,
  onTune,
  onPassband,
  onNotches,
}: Props) {
  const specRef = useRef<HTMLCanvasElement>(null);
  const fallRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<FftFrame | null>(null);
  // mutable view of tuning state for the draw loop / event handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const range = useRef({ min: -90, max: -20 });
  const dpr = useRef(1);
  const pal = useRef<Palette>(readPalette());

  useEffect(() => subscribeFft((f) => (frameRef.current = f)), [subscribeFft]);

  // Resize canvases to their container. Spectrum is rendered at device
  // resolution for a crisp trace; the waterfall stays 1:1 (it scrolls via
  // putImageData, which ignores transforms).
  useEffect(() => {
    pal.current = readPalette();
    const resize = () => {
      const wrap = wrapRef.current;
      const spec = specRef.current;
      const fall = fallRef.current;
      if (!wrap || !spec || !fall) return;
      const w = wrap.clientWidth;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      dpr.current = ratio;
      const fallH = Math.max(120, wrap.clientHeight - SPECTRUM_H);

      if (spec.width !== w * ratio || spec.height !== SPECTRUM_H * ratio) {
        spec.width = w * ratio;
        spec.height = SPECTRUM_H * ratio;
      }
      if (fall.width !== w || fall.height !== fallH) {
        fall.width = w;
        fall.height = fallH;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Draw loop.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const frame = frameRef.current;
      const spec = specRef.current;
      const fall = fallRef.current;
      if (!spec || !fall) return;
      const sctx = spec.getContext("2d");
      const fctx = fall.getContext("2d");
      if (!sctx || !fctx) return;

      const p = pal.current;
      const ratio = dpr.current;
      const w = spec.width / ratio; // logical (CSS) px
      const h = SPECTRUM_H;
      sctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Idle screen until the first frame arrives.
      sctx.fillStyle = p.screen;
      sctx.fillRect(0, 0, w, h);
      drawGrid(sctx, w, h, p);

      if (!frame) {
        drawFilterOverlay(sctx, w, h, stateRef.current, p);
        drawFreqAxis(sctx, w, h, stateRef.current, p);
        drawVfo(sctx, w, h, stateRef.current, p);
        drawNotches(sctx, w, h, stateRef.current);
        return;
      }

      const bins = frame.bins;
      const Nb = bins.length;

      // Smoothly track dB range for autoscaling.
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < Nb; i++) {
        const v = bins[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      range.current.min += 0.05 * (lo - 5 - range.current.min);
      range.current.max += 0.05 * (hi + 5 - range.current.max);
      const min = range.current.min;
      const span = Math.max(1, range.current.max - min);

      // --- spectrum: filled trace ---
      drawFilterOverlay(sctx, w, h, stateRef.current, p);

      const traceY = (x: number) => {
        const v = bins[(((x / w) * Nb) | 0) % Nb]!;
        return h - ((v - min) / span) * h;
      };
      sctx.beginPath();
      sctx.moveTo(0, traceY(0));
      for (let x = 1; x < w; x++) sctx.lineTo(x, traceY(x));
      sctx.lineTo(w, h);
      sctx.lineTo(0, h);
      sctx.closePath();
      sctx.fillStyle = p.traceFill;
      sctx.fill();

      sctx.beginPath();
      sctx.moveTo(0, traceY(0));
      for (let x = 1; x < w; x++) sctx.lineTo(x, traceY(x));
      sctx.strokeStyle = p.trace;
      sctx.lineWidth = 1.25;
      sctx.lineJoin = "round";
      sctx.stroke();

      drawFreqAxis(sctx, w, h, stateRef.current, p);
      drawVfo(sctx, w, h, stateRef.current, p);
      drawNotches(sctx, w, h, stateRef.current);

      // --- waterfall ---
      const fw = fall.width;
      const fh = fall.height;
      fctx.drawImage(fall, 0, 0, fw, fh, 0, 1, fw, fh); // scroll down 1px
      const rowImg = fctx.createImageData(fw, 1);
      const d = rowImg.data;
      for (let x = 0; x < fw; x++) {
        const v = bins[(((x / fw) * Nb) | 0) % Nb]!;
        const norm = Math.min(1, Math.max(0, (v - min) / span));
        const [r, g, b] = waterfallColor(norm);
        const o = x * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      fctx.putImageData(rowImg, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pointer interaction. A click can tune the VFO, drag a filter edge (passband
  // tuning), ⇧-drag to shift the whole passband (IF shift), or ⌥-click to add /
  // remove a notch. We hit-test against the live state via stateRef.
  const drag = useRef<{
    kind: "tune" | "low" | "high" | "shift";
    startFrac: number;
    startLow: number;
    startHigh: number;
  } | null>(null);

  const fracFromClientX = (clientX: number): number => {
    const rect = specRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const toggleNotch = (frac: number, w: number) => {
    const s = stateRef.current;
    const px = frac * w;
    const hz = s.centerHz + (frac - 0.5) * s.sampleRate;
    const near = s.notches.find(
      (n) => Math.abs(offsetX(w, s, n - s.centerHz) - px) <= NOTCH_GRAB_PX,
    );
    if (near != null) onNotches(s.notches.filter((n) => n !== near));
    else onNotches([...s.notches, Math.round(hz)]);
  };

  const onDown = (e: ReactPointerEvent) => {
    const spec = specRef.current;
    if (!spec) return;
    spec.setPointerCapture(e.pointerId);
    const s = stateRef.current;
    const w = spec.getBoundingClientRect().width;
    const frac = fracFromClientX(e.clientX);
    const x = frac * w;

    if (e.altKey) {
      toggleNotch(frac, w);
      return;
    }
    const base = {
      startFrac: frac,
      startLow: s.filterLow,
      startHigh: s.filterHigh,
    };
    if (e.shiftKey) {
      drag.current = { kind: "shift", ...base };
      return;
    }
    const xLow = offsetX(w, s, s.vfoOffset + s.filterLow);
    const xHigh = offsetX(w, s, s.vfoOffset + s.filterHigh);
    if (Math.abs(x - xLow) <= EDGE_GRAB_PX) drag.current = { kind: "low", ...base };
    else if (Math.abs(x - xHigh) <= EDGE_GRAB_PX)
      drag.current = { kind: "high", ...base };
    else {
      drag.current = { kind: "tune", ...base };
      onTune(Math.round((frac - 0.5) * s.sampleRate));
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    const spec = specRef.current;
    if (!spec) return;
    const s = stateRef.current;
    const w = spec.getBoundingClientRect().width;

    if (e.buttons !== 1 || !drag.current) {
      // hover cursor hint
      const frac = fracFromClientX(e.clientX);
      const x = frac * w;
      const near =
        Math.abs(x - offsetX(w, s, s.vfoOffset + s.filterLow)) <= EDGE_GRAB_PX ||
        Math.abs(x - offsetX(w, s, s.vfoOffset + s.filterHigh)) <= EDGE_GRAB_PX;
      spec.style.cursor = e.altKey ? "cell" : near ? "ew-resize" : "crosshair";
      return;
    }

    const frac = fracFromClientX(e.clientX);
    const offFromVfo = (frac - 0.5) * s.sampleRate - s.vfoOffset;
    const d = drag.current;
    switch (d.kind) {
      case "tune":
        onTune(Math.round((frac - 0.5) * s.sampleRate));
        break;
      case "low":
        onPassband(Math.min(offFromVfo, s.filterHigh - 50), s.filterHigh);
        break;
      case "high":
        onPassband(s.filterLow, Math.max(offFromVfo, s.filterLow + 50));
        break;
      case "shift": {
        const delta = (frac - d.startFrac) * s.sampleRate;
        onPassband(d.startLow + delta, d.startHigh + delta);
        break;
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden border bg-[var(--screen)]"
    >
      <canvas
        ref={specRef}
        className="block w-full cursor-crosshair"
        style={{ height: SPECTRUM_H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          const step = e.shiftKey ? 1000 : 100;
          onTune(stateRef.current.vfoOffset - Math.sign(e.deltaY) * step);
        }}
      />
      <canvas ref={fallRef} className="block w-full cursor-crosshair" />
    </div>
  );
}

// --- canvas helpers --------------------------------------------------------

function vfoX(w: number, s: RadioState): number {
  return ((s.vfoOffset + s.sampleRate / 2) / s.sampleRate) * w;
}

/** Pixel x for a frequency offset (Hz) from the captured-band centre. */
function offsetX(w: number, s: RadioState, offsetFromCenterHz: number): number {
  return ((offsetFromCenterHz + s.sampleRate / 2) / s.sampleRate) * w;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: Palette,
) {
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 1; g < 8; g++) {
    const x = Math.round((g / 8) * w) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let g = 1; g < 4; g++) {
    const y = Math.round((g / 4) * h) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

function drawFilterOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
  p: Palette,
) {
  const x0 = offsetX(w, s, s.vfoOffset + s.filterLow);
  const x1 = offsetX(w, s, s.vfoOffset + s.filterHigh);
  ctx.fillStyle = p.vfoFill;
  ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);

  // Draggable edge handles.
  ctx.strokeStyle = p.vfo;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const ex of [x0, x1]) {
    ctx.moveTo(Math.round(ex) + 0.5, 0);
    ctx.lineTo(Math.round(ex) + 0.5, h);
  }
  ctx.stroke();
  ctx.fillStyle = p.vfo;
  for (const ex of [x0, x1]) ctx.fillRect(Math.round(ex) - 1, h / 2 - 9, 3, 18);
}

const NOTCH_COLOR = "oklch(0.7 0.19 25)"; // red

function drawNotches(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
) {
  if (!s.notches.length) return;
  ctx.save();
  ctx.strokeStyle = NOTCH_COLOR;
  ctx.fillStyle = NOTCH_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const hz of s.notches) {
    const x = offsetX(w, s, hz - s.centerHz);
    if (x < -2 || x > w + 2) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = "9px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const hz of s.notches) {
    const x = offsetX(w, s, hz - s.centerHz);
    if (x < -2 || x > w + 2) continue;
    ctx.fillText("⊘", Math.round(x), 2);
  }
  ctx.restore();
}

function drawVfo(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
  p: Palette,
) {
  const x = vfoX(w, s);
  ctx.strokeStyle = p.vfo;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, h);
  ctx.stroke();

  // Tuned-frequency label, kept inside the canvas bounds.
  const tuned = s.centerHz + s.vfoOffset;
  const label = formatHz(tuned);
  ctx.font =
    "600 11px ui-monospace, 'SF Mono', Menlo, monospace";
  const tw = ctx.measureText(label).width;
  const pad = 5;
  let lx = x + 6;
  if (lx + tw + pad * 2 > w) lx = x - 6 - tw - pad * 2;
  ctx.fillStyle = p.vfo;
  ctx.fillRect(lx, 4, tw + pad * 2, 17);
  ctx.fillStyle = "oklch(0.16 0.02 282)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, lx + pad, 4 + 9);
}

function drawFreqAxis(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
  p: Palette,
) {
  ctx.fillStyle = p.axis;
  ctx.font = "10px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.textBaseline = "bottom";
  const half = s.sampleRate / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  for (const t of ticks) {
    const hz = s.centerHz - half + t * s.sampleRate;
    const label = formatHz(hz);
    const x = t * w;
    ctx.textAlign = t === 0 ? "left" : t === 1 ? "right" : "center";
    ctx.fillText(label, x === 0 ? 4 : x === w ? w - 4 : x, h - 4);
  }
}

// Perceptual-ish waterfall colormap (deep blue → teal → green → amber → red),
// tuned so the noise floor blends into the dark screen.
function waterfallColor(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.0, 10, 12, 24],
    [0.28, 26, 58, 132],
    [0.52, 28, 150, 140],
    [0.7, 70, 200, 120],
    [0.85, 232, 196, 70],
    [1.0, 240, 70, 50],
  ];
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
  return [240, 70, 50];
}
