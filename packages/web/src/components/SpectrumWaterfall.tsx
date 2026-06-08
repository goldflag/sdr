// Spectrum plot (top) + scrolling waterfall (bottom) sharing one frequency axis.
// Pulls the latest FFT frame via subscription and redraws on an rAF loop (no
// React re-render per frame). Click/drag tunes the VFO; wheel fine-tunes.

import { useEffect, useRef } from "react";
import type { FftFrame } from "@sdr/shared";
import type { RadioState } from "@sdr/shared";
import { formatHz } from "@/lib/utils";

interface Props {
  subscribeFft: (cb: (f: FftFrame) => void) => () => void;
  state: RadioState;
  onTune: (offsetHz: number) => void;
}

const SPECTRUM_H = 150;

export function SpectrumWaterfall({ subscribeFft, state, onTune }: Props) {
  const specRef = useRef<HTMLCanvasElement>(null);
  const fallRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<FftFrame | null>(null);
  // mutable view of tuning state for the draw loop / event handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const range = useRef({ min: -90, max: -20 });

  useEffect(() => subscribeFft((f) => (frameRef.current = f)), [subscribeFft]);

  // Resize canvases to their container.
  useEffect(() => {
    const resize = () => {
      const wrap = wrapRef.current;
      const spec = specRef.current;
      const fall = fallRef.current;
      if (!wrap || !spec || !fall) return;
      const w = wrap.clientWidth;
      const fallH = Math.max(120, wrap.clientHeight - SPECTRUM_H);
      for (const [c, h] of [
        [spec, SPECTRUM_H],
        [fall, fallH],
      ] as const) {
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
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
      if (!frame || !spec || !fall) return;
      const sctx = spec.getContext("2d");
      const fctx = fall.getContext("2d");
      if (!sctx || !fctx) return;

      const w = spec.width;
      const bins = frame.bins;
      const N = bins.length;

      // Smoothly track dB range for autoscaling.
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < N; i++) {
        const v = bins[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      range.current.min += 0.05 * (lo - 5 - range.current.min);
      range.current.max += 0.05 * (hi + 5 - range.current.max);
      const min = range.current.min;
      const span = Math.max(1, range.current.max - min);

      // --- spectrum ---
      const h = spec.height;
      sctx.clearRect(0, 0, w, h);
      sctx.fillStyle = "rgba(20,24,28,1)";
      sctx.fillRect(0, 0, w, h);
      // grid
      sctx.strokeStyle = "rgba(255,255,255,0.05)";
      sctx.lineWidth = 1;
      for (let g = 1; g < 8; g++) {
        const x = (g / 8) * w;
        sctx.beginPath();
        sctx.moveTo(x, 0);
        sctx.lineTo(x, h);
        sctx.stroke();
      }
      drawFilterOverlay(sctx, w, h, stateRef.current);
      // trace
      sctx.beginPath();
      for (let x = 0; x < w; x++) {
        const v = bins[(((x / w) * N) | 0) % N]!;
        const y = h - ((v - min) / span) * h;
        if (x === 0) sctx.moveTo(x, y);
        else sctx.lineTo(x, y);
      }
      sctx.lineTo(w, h);
      sctx.lineTo(0, h);
      sctx.closePath();
      sctx.fillStyle = "rgba(52,211,153,0.18)";
      sctx.fill();
      sctx.strokeStyle = "rgb(52,211,153)";
      sctx.lineWidth = 1.25;
      sctx.beginPath();
      for (let x = 0; x < w; x++) {
        const v = bins[(((x / w) * N) | 0) % N]!;
        const y = h - ((v - min) / span) * h;
        if (x === 0) sctx.moveTo(x, y);
        else sctx.lineTo(x, y);
      }
      sctx.stroke();
      drawVfoLine(sctx, w, h, stateRef.current);

      // --- waterfall ---
      const fw = fall.width;
      const fh = fall.height;
      fctx.drawImage(fall, 0, 0, fw, fh, 0, 1, fw, fh); // scroll down 1px
      const row = fctx.createImageData(fw, 1);
      const d = row.data;
      for (let x = 0; x < fw; x++) {
        const v = bins[(((x / fw) * N) | 0) % N]!;
        const norm = Math.min(1, Math.max(0, (v - min) / span));
        const [r, g, b] = waterfallColor(norm);
        const o = x * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      fctx.putImageData(row, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pointer tuning.
  const tuneFromClientX = (clientX: number) => {
    const spec = specRef.current;
    if (!spec) return;
    const rect = spec.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    const offset = (frac - 0.5) * stateRef.current.sampleRate;
    onTune(Math.round(offset));
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden rounded-lg border bg-[rgb(20,24,28)]"
    >
      <canvas
        ref={specRef}
        className="block w-full cursor-crosshair"
        style={{ height: SPECTRUM_H }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          tuneFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) tuneFromClientX(e.clientX);
        }}
        onWheel={(e) => {
          const step = e.shiftKey ? 1000 : 100;
          onTune(stateRef.current.vfoOffset - Math.sign(e.deltaY) * step);
        }}
      />
      <canvas ref={fallRef} className="block w-full cursor-crosshair" />
      <div className="pointer-events-none absolute left-2 top-1 font-mono text-[10px] text-muted-foreground">
        {formatHz(state.centerHz - state.sampleRate / 2)}
      </div>
      <div className="pointer-events-none absolute right-2 top-1 font-mono text-[10px] text-muted-foreground">
        {formatHz(state.centerHz + state.sampleRate / 2)}
      </div>
    </div>
  );
}

function vfoX(w: number, s: RadioState): number {
  return ((s.vfoOffset + s.sampleRate / 2) / s.sampleRate) * w;
}

function drawVfoLine(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
) {
  const x = vfoX(w, s);
  ctx.strokeStyle = "rgba(250,204,21,0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
}

function drawFilterOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RadioState,
) {
  const x = vfoX(w, s);
  const halfPx = (s.bandwidth / 2 / s.sampleRate) * w;
  let x0 = x - halfPx;
  let x1 = x + halfPx;
  if (s.mode === "USB") x0 = x;
  if (s.mode === "LSB") x1 = x;
  ctx.fillStyle = "rgba(250,204,21,0.10)";
  ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
}

// Simple perceptual-ish waterfall colormap (dark -> blue -> green -> yellow -> red).
function waterfallColor(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.0, 8, 12, 28],
    [0.3, 20, 60, 140],
    [0.55, 30, 160, 130],
    [0.78, 230, 200, 60],
    [1.0, 250, 60, 40],
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
  return [250, 60, 40];
}
