// NOAA APT main view: a live canvas that paints one grayscale scanline per
// incoming APT_LINE frame (2 lines/sec), newest at the bottom, scrolling once it
// fills. The full 2080-pixel line is shown — sync bars, both video channels and
// telemetry wedges — i.e. the authentic dual-image APT frame. Lines arrive
// already sync-aligned from the server, so the picture stays vertically straight.

import { useCallback, useEffect, useRef, useState } from "react";
import { APT_PIXELS, type AptLineFrame } from "@sdr/shared";
import { Satellite, Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AptStats } from "@/lib/ws";

const WIDTH = APT_PIXELS; // 2080
const MAX_ROWS = 1600; // ~13 min of pass before it scrolls

interface Props {
  subscribeApt: (cb: (f: AptLineFrame) => void) => () => void;
  stats: AptStats | null;
}

export function AptView({ subscribeApt, stats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rowRef = useRef(0); // next y to draw at (clamped to MAX_ROWS once full)
  const lastLineRef = useRef(-1); // detect a server-side pass reset (lineNo wrap)
  const imgRef = useRef<ImageData | null>(null);
  const hasImageRef = useRef(false);
  const [hasImage, setHasImage] = useState(false);

  // One-time canvas/context setup.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = WIDTH;
    cv.height = MAX_ROWS;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctxRef.current = ctx;
    imgRef.current = ctx?.createImageData(WIDTH, 1) ?? null;
  }, []);

  const clear = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx) ctx.clearRect(0, 0, WIDTH, MAX_ROWS);
    rowRef.current = 0;
    lastLineRef.current = -1;
    hasImageRef.current = false;
    setHasImage(false);
  }, []);

  const drawLine = useCallback((f: AptLineFrame) => {
    const ctx = ctxRef.current;
    const img = imgRef.current;
    const cv = canvasRef.current;
    if (!ctx || !img || !cv) return;

    // A fresh pass (new satellite / re-entry) restarts numbering at 0.
    if (lastLineRef.current >= 0 && f.lineNo <= lastLineRef.current) {
      ctx.clearRect(0, 0, WIDTH, MAX_ROWS);
      rowRef.current = 0;
    }
    lastLineRef.current = f.lineNo;

    const d = img.data;
    const px = f.pixels;
    const w = Math.min(px.length, WIDTH);
    for (let x = 0; x < w; x++) {
      const v = px[x]!;
      const o = x * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }

    let y = rowRef.current;
    if (y >= MAX_ROWS) {
      ctx.drawImage(cv, 0, -1); // scroll up one row
      y = MAX_ROWS - 1;
    } else {
      rowRef.current = y + 1;
    }
    ctx.putImageData(img, 0, y);

    if (!hasImageRef.current) {
      hasImageRef.current = true;
      setHasImage(true);
    }
    // Keep newest line in view if the user is parked near the bottom.
    const sc = scrollRef.current;
    if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80) {
      sc.scrollTop = sc.scrollHeight;
    }
  }, []);

  useEffect(() => subscribeApt(drawLine), [subscribeApt, drawLine]);

  const savePng = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || rowRef.current === 0) return;
    // Crop to the filled region so we don't export empty rows.
    const h = rowRef.current;
    const tmp = document.createElement("canvas");
    tmp.width = WIDTH;
    tmp.height = h;
    tmp.getContext("2d")?.drawImage(cv, 0, 0, WIDTH, h, 0, 0, WIDTH, h);
    const a = document.createElement("a");
    a.href = tmp.toDataURL("image/png");
    a.download = `apt-${(stats ? stats.freqHz / 1e6 : 137).toFixed(3)}MHz.png`;
    a.click();
  }, [stats]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {stats?.lines ?? 0} lines ·{" "}
          {stats && stats.sync > 0.45 ? (
            <span className="text-primary">lock {Math.round(stats.sync * 100)}%</span>
          ) : (
            <span>searching…</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={savePng} disabled={!hasImage}>
            <Download /> PNG
          </Button>
          <Button size="xs" variant="ghost" onClick={clear} disabled={!hasImage}>
            <Trash2 /> Clear
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto bg-black">
        {!hasImage && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Satellite className="size-7 opacity-50" />
            <p className="text-sm">Waiting for a satellite pass…</p>
            <p className="max-w-sm text-center text-xs text-muted-foreground/80">
              The image draws here line-by-line once a NOAA bird is overhead and
              the decoder locks sync. Nothing transmits between passes — this is
              normal.
            </p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="block w-full"
          style={{ imageRendering: "auto" }}
        />
      </div>
    </div>
  );
}
