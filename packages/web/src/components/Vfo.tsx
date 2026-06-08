// Large tuned-frequency readout with per-digit scroll/click tuning. The tuned
// frequency is centerHz + vfoOffset; digit tuning adjusts the dongle center
// while preserving the VFO offset.

import { LIMITS } from "@sdr/shared";
import type { RadioState } from "@sdr/shared";
import { Button } from "@/components/ui/button";
import { Crosshair } from "lucide-react";

interface Props {
  state: RadioState;
  onSetCenter: (hz: number) => void;
  onSetOffset: (hz: number) => void;
}

// place values (Hz) for the 9 tunable digits, high -> low
const PLACES = [1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1e2, 1e1, 1e0];

export function Vfo({ state, onSetCenter, onSetOffset }: Props) {
  const tuned = state.centerHz + state.vfoOffset;
  const digits = String(Math.round(tuned)).padStart(9, "0").slice(-9).split("");

  const bump = (place: number, dir: number) => {
    const next = clamp(tuned + place * dir);
    onSetCenter(next - state.vfoOffset);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between">
        <div className="flex select-none items-baseline font-mono tabular-nums">
          {digits.map((d, i) => {
            const place = PLACES[i]!;
            const showSep = i > 0 && (9 - i) % 3 === 0;
            return (
              <span key={i} className="flex items-baseline">
                {showSep && (
                  <span className="px-0.5 text-2xl text-muted-foreground/40">
                    ,
                  </span>
                )}
                <button
                  className="rounded px-0.5 text-3xl leading-none text-foreground transition-colors hover:bg-accent hover:text-primary"
                  onWheel={(e) => bump(place, e.deltaY < 0 ? 1 : -1)}
                  onClick={() => bump(place, 1)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    bump(place, -1);
                  }}
                  title={`${place} Hz — scroll or click (right-click to decrease)`}
                >
                  {d}
                </button>
              </span>
            );
          })}
          <span className="ml-1.5 text-sm text-muted-foreground">Hz</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onSetCenter(tuned);
            onSetOffset(0);
          }}
          title="Recenter the band on the VFO"
        >
          <Crosshair className="size-3.5" /> Center
        </Button>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
        <span>center {(state.centerHz / 1e6).toFixed(4)} MHz</span>
        <span>
          offset {state.vfoOffset >= 0 ? "+" : ""}
          {(state.vfoOffset / 1e3).toFixed(2)} kHz
        </span>
      </div>
    </div>
  );
}

function clamp(hz: number): number {
  return Math.min(LIMITS.MAX_HZ, Math.max(LIMITS.MIN_HZ, hz));
}
