// Spectrum plot (top) + scrolling waterfall (bottom) sharing one frequency axis.
// Pulls the latest FFT frame via subscription and redraws on an rAF loop (no
// React re-render per frame).
//
// Interaction:
//   • spectrum  — click/drag tunes; drag a filter edge = passband; ⇧-drag = IF
//                 shift; ⌥-click = add/remove a notch.
//   • wheel     — zoom the view at the cursor; ⇧-wheel pans.
//   • waterfall — drag to pan when zoomed in.
//   • double-click anywhere — reset to the full span.
//
// The visible window is a sub-range of the captured band, tracked in `view`
// (centre + span as fractions of the band). All drawing/​hit-testing maps band
// fractions to pixels through that window, so zoom/pan are purely a display
// transform. Colors come from the theme palette plus the selected colormap.

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { FftFrame, RadioState } from "@sdr/shared";
import { formatHz } from "@/lib/utils";
import { colormapLut } from "@/lib/colormaps";
import type { DisplaySettings } from "@/components/SpectrumDisplay";
import { Button } from "@/components/ui/button";

interface Props {
  subscribeFft: (cb: (f: FftFrame) => void) => () => void;
  state: RadioState;
  display: DisplaySettings;
  onTune: (offsetHz: number) => void;
  onPassband: (low: number, high: number) => void;
  onNotches: (notches: number[]) => void;
}

const EDGE_GRAB_PX = 7; // pointer distance to grab a filter edge
const NOTCH_GRAB_PX = 7; // pointer distance to remove a notch
const MIN_SPAN = 0.01; // max zoom = 100×
const SPECTRUM_H = 168;

interface View {
  center: number; // 0..1 within the captured band
  span: number; // (0..1], fraction of the band shown
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function clampView(center: number, span: number): View {
  const sp = Math.min(1, Math.max(MIN_SPAN, span));
  const c = Math.min(1 - sp / 2, Math.max(sp / 2, center));
  return { center: c, span: sp };
}

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
  display,
  onTune,
  onPassband,
  onNotches,
}: Props) {
  const specRef = useRef<HTMLCanvasElement>(null);
  const fallRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<FftFrame | null>(null);
  // mutable mirrors for the draw loop / event handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispRef = useRef(display);
  dispRef.current = display;
  const range = useRef({ min: -90, max: -20 });
  const dpr = useRef(1);
  const pal = useRef<Palette>(readPalette());
  const view = useRef<View>({ center: 0.5, span: 1 });
  const viewDirty = useRef(false); // clear waterfall history on zoom/pan
  const [zoom, setZoom] = useState(1);

  useEffect(() => subscribeFft((f) => (frameRef.current = f)), [subscribeFft]);

  const setView = (center: number, span: number) => {
    view.current = clampView(center, span);
    viewDirty.current = true;
    setZoom(1 / view.current.span);
  };
  const resetView = () => setView(0.5, 1);

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
      const s = stateRef.current;
      const disp = dispRef.current;
      const v = view.current;
      const ratio = dpr.current;
      const w = spec.width / ratio; // logical (CSS) px
      const h = SPECTRUM_H;
      sctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Clear the waterfall history when the view changes (old rows used the
      // previous mapping and would otherwise be misaligned).
      if (viewDirty.current) {
        fctx.fillStyle = p.screen;
        fctx.fillRect(0, 0, fall.width, fall.height);
        viewDirty.current = false;
      }

      // Idle screen until the first frame arrives.
      sctx.fillStyle = p.screen;
      sctx.fillRect(0, 0, w, h);
      drawGrid(sctx, w, h, p);

      if (!frame) {
        drawFilterOverlay(sctx, w, h, s, v, p);
        drawFreqAxis(sctx, w, h, s, v, p);
        drawVfo(sctx, w, h, s, v, p);
        drawNotches(sctx, w, h, s, v);
        return;
      }

      const bins = frame.bins;
      const Nb = bins.length;
      const lo = v.center - v.span / 2;

      // dB range: auto-scaling tracks the live floor/peak; manual uses fixed
      // floor/ceiling sliders for stable contrast.
      let min: number;
      let span: number;
      if (disp.autoContrast) {
        let bLo = Infinity;
        let bHi = -Infinity;
        for (let i = 0; i < Nb; i++) {
          const val = bins[i]!;
          if (val < bLo) bLo = val;
          if (val > bHi) bHi = val;
        }
        range.current.min += 0.05 * (bLo - 5 - range.current.min);
        range.current.max += 0.05 * (bHi + 5 - range.current.max);
        min = range.current.min;
        span = Math.max(1, range.current.max - min);
      } else {
        min = disp.floorDb;
        span = Math.max(1, disp.ceilDb - disp.floorDb);
      }

      // band fraction visible at pixel x -> bin value
      const binAt = (frac: number) => {
        const f = lo + frac * v.span;
        let idx = (f * Nb) | 0;
        if (idx < 0) idx = 0;
        else if (idx >= Nb) idx = Nb - 1;
        return bins[idx]!;
      };

      // --- spectrum: filled trace ---
      drawFilterOverlay(sctx, w, h, s, v, p);

      const traceY = (x: number) => h - ((binAt(x / w) - min) / span) * h;
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

      drawFreqAxis(sctx, w, h, s, v, p);
      drawVfo(sctx, w, h, s, v, p);
      drawNotches(sctx, w, h, s, v);

      // --- waterfall ---
      const fw = fall.width;
      const fh = fall.height;
      const lut = colormapLut(disp.colormap);
      fctx.drawImage(fall, 0, 0, fw, fh, 0, 1, fw, fh); // scroll down 1px
      const rowImg = fctx.createImageData(fw, 1);
      const d = rowImg.data;
      for (let x = 0; x < fw; x++) {
        const norm = clamp01((binAt(x / fw) - min) / span);
        const li = (norm * 255) | 0;
        const o = x * 4;
        d[o] = lut[li * 3]!;
        d[o + 1] = lut[li * 3 + 1]!;
        d[o + 2] = lut[li * 3 + 2]!;
        d[o + 3] = 255;
      }
      fctx.putImageData(rowImg, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- spectrum pointer interaction (tune / passband / notch) ---
  const drag = useRef<{
    kind: "tune" | "low" | "high" | "shift";
    startFrac: number;
    startLow: number;
    startHigh: number;
  } | null>(null);

  const fracFromClientX = (clientX: number): number => {
    const rect = specRef.current!.getBoundingClientRect();
    return clamp01((clientX - rect.left) / rect.width);
  };
  // band fraction (0..1 within the captured band) under a canvas fraction
  const offsetFromVfo = (frac: number): number => {
    const s = stateRef.current;
    const v = view.current;
    const bandFrac = v.center - v.span / 2 + frac * v.span;
    return (bandFrac - 0.5) * s.sampleRate - s.vfoOffset;
  };

  const toggleNotch = (frac: number, w: number) => {
    const s = stateRef.current;
    const v = view.current;
    const px = frac * w;
    const hz = s.centerHz + offsetFromVfo(frac) + s.vfoOffset;
    const near = s.notches.find(
      (n) => Math.abs(offsetX(w, s, v, n - s.centerHz) - px) <= NOTCH_GRAB_PX,
    );
    if (near != null) onNotches(s.notches.filter((n) => n !== near));
    else onNotches([...s.notches, Math.round(hz)]);
  };

  const onDown = (e: ReactPointerEvent) => {
    const spec = specRef.current;
    if (!spec) return;
    spec.setPointerCapture(e.pointerId);
    const s = stateRef.current;
    const v = view.current;
    const w = spec.getBoundingClientRect().width;
    const frac = fracFromClientX(e.clientX);
    const x = frac * w;

    if (e.altKey) {
      toggleNotch(frac, w);
      return;
    }
    const base = { startFrac: frac, startLow: s.filterLow, startHigh: s.filterHigh };
    if (e.shiftKey) {
      drag.current = { kind: "shift", ...base };
      return;
    }
    const xLow = offsetX(w, s, v, s.vfoOffset + s.filterLow);
    const xHigh = offsetX(w, s, v, s.vfoOffset + s.filterHigh);
    if (Math.abs(x - xLow) <= EDGE_GRAB_PX) drag.current = { kind: "low", ...base };
    else if (Math.abs(x - xHigh) <= EDGE_GRAB_PX)
      drag.current = { kind: "high", ...base };
    else {
      drag.current = { kind: "tune", ...base };
      onTune(Math.round(offsetFromVfo(frac) + s.vfoOffset));
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    const spec = specRef.current;
    if (!spec) return;
    const s = stateRef.current;
    const v = view.current;
    const w = spec.getBoundingClientRect().width;

    if (e.buttons !== 1 || !drag.current) {
      const frac = fracFromClientX(e.clientX);
      const x = frac * w;
      const near =
        Math.abs(x - offsetX(w, s, v, s.vfoOffset + s.filterLow)) <=
          EDGE_GRAB_PX ||
        Math.abs(x - offsetX(w, s, v, s.vfoOffset + s.filterHigh)) <=
          EDGE_GRAB_PX;
      spec.style.cursor = e.altKey ? "cell" : near ? "ew-resize" : "crosshair";
      return;
    }

    const frac = fracFromClientX(e.clientX);
    const off = offsetFromVfo(frac);
    const d = drag.current;
    switch (d.kind) {
      case "tune":
        onTune(Math.round(off + s.vfoOffset));
        break;
      case "low":
        onPassband(Math.min(off, s.filterHigh - 50), s.filterHigh);
        break;
      case "high":
        onPassband(s.filterLow, Math.max(off, s.filterLow + 50));
        break;
      case "shift": {
        const delta = (frac - d.startFrac) * v.span * s.sampleRate;
        onPassband(d.startLow + delta, d.startHigh + delta);
        break;
      }
    }
  };

  // --- zoom (wheel) + pan (⇧-wheel, waterfall drag) ---
  const onWheel = (e: ReactWheelEvent) => {
    const spec = specRef.current;
    if (!spec) return;
    const v = view.current;
    const cursor = fracFromClientX(e.clientX);
    if (e.shiftKey) {
      setView(v.center + (e.deltaY > 0 ? 1 : -1) * v.span * 0.15, v.span);
      return;
    }
    const fUnder = v.center - v.span / 2 + cursor * v.span;
    const span = v.span * (e.deltaY < 0 ? 1 / 1.25 : 1.25);
    setView(fUnder - cursor * span + span / 2, span);
  };

  const fallDrag = useRef<{ x: number; center: number } | null>(null);
  const onFallDown = (e: ReactPointerEvent) => {
    if (view.current.span >= 1) return; // nothing to pan at full span
    fallRef.current?.setPointerCapture(e.pointerId);
    fallDrag.current = { x: e.clientX, center: view.current.center };
  };
  const onFallMove = (e: ReactPointerEvent) => {
    const fall = fallRef.current;
    if (!fall) return;
    fall.style.cursor =
      view.current.span < 1 ? (fallDrag.current ? "grabbing" : "grab") : "default";
    if (e.buttons !== 1 || !fallDrag.current) return;
    const dx = (e.clientX - fallDrag.current.x) / fall.getBoundingClientRect().width;
    setView(fallDrag.current.center - dx * view.current.span, view.current.span);
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden border bg-[var(--screen)]"
      onWheel={onWheel}
      onDoubleClick={resetView}
    >
      <canvas
        ref={specRef}
        className="block w-full cursor-crosshair"
        style={{ height: SPECTRUM_H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
      />
      <canvas
        ref={fallRef}
        className="block w-full"
        onPointerDown={onFallDown}
        onPointerMove={onFallMove}
        onPointerUp={() => (fallDrag.current = null)}
      />
      {zoom > 1.01 && (
        <div className="absolute left-2 top-2 flex items-center gap-1 rounded-sm bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80 backdrop-blur">
          <span>{zoom.toFixed(1)}×</span>
          <Button
            size="xs"
            variant="ghost"
            className="h-4 px-1 text-[10px]"
            onClick={resetView}
          >
            reset
          </Button>
        </div>
      )}
    </div>
  );
}

// --- canvas helpers --------------------------------------------------------

/** Pixel x for a band fraction (0..1), through the current view window. */
function bandFracToX(w: number, v: View, f: number): number {
  return ((f - (v.center - v.span / 2)) / v.span) * w;
}

/** Pixel x for a frequency offset (Hz) from the captured-band centre. */
function offsetX(w: number, s: RadioState, v: View, offFromCenterHz: number): number {
  return bandFracToX(w, v, (offFromCenterHz + s.sampleRate / 2) / s.sampleRate);
}

function vfoX(w: number, s: RadioState, v: View): number {
  return offsetX(w, s, v, s.vfoOffset);
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
  v: View,
  p: Palette,
) {
  const x0 = offsetX(w, s, v, s.vfoOffset + s.filterLow);
  const x1 = offsetX(w, s, v, s.vfoOffset + s.filterHigh);
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
  v: View,
) {
  if (!s.notches.length) return;
  ctx.save();
  ctx.strokeStyle = NOTCH_COLOR;
  ctx.fillStyle = NOTCH_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const hz of s.notches) {
    const x = offsetX(w, s, v, hz - s.centerHz);
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
    const x = offsetX(w, s, v, hz - s.centerHz);
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
  v: View,
  p: Palette,
) {
  const x = vfoX(w, s, v);
  if (x < -1 || x > w + 1) return; // VFO scrolled out of the zoomed view
  ctx.strokeStyle = p.vfo;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, h);
  ctx.stroke();

  // Tuned-frequency label, kept inside the canvas bounds.
  const tuned = s.centerHz + s.vfoOffset;
  const label = formatHz(tuned);
  ctx.font = "600 11px ui-monospace, 'SF Mono', Menlo, monospace";
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
  v: View,
  p: Palette,
) {
  ctx.fillStyle = p.axis;
  ctx.font = "10px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.textBaseline = "bottom";
  const bandLo = s.centerHz - s.sampleRate / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  for (const t of ticks) {
    const f = v.center - v.span / 2 + t * v.span;
    const hz = bandLo + f * s.sampleRate;
    const label = formatHz(hz);
    const x = t * w;
    ctx.textAlign = t === 0 ? "left" : t === 1 ? "right" : "center";
    ctx.fillText(label, x === 0 ? 4 : x === w ? w - 4 : x, h - 4);
  }
}
