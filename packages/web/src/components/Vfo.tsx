// Tuned-frequency readout and primary tuning control.
//
// Every digit is individually editable in place — no separate text-entry mode:
//   1. Click (or Tab to) a digit, then type 0–9 to set it; focus advances right.
//   2. Hover a digit and use the ▲/▼ steppers, or scroll the wheel over it.
//   3. Keyboard: ArrowUp/Down nudge the focused digit, ArrowLeft/Right move it.
//
// The tuned frequency is centerHz + vfoOffset; changing a digit moves the dongle
// center while preserving the VFO offset, so the signal under the cursor stays put.

import { LIMITS, MODES } from "@sdr/shared";
import type { ClientMessage, Mode, RadioState } from "@sdr/shared";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronUp, ChevronDown, Crosshair } from "lucide-react";

interface Props {
  state: RadioState;
  send: (msg: ClientMessage) => void;
}

// Plain-language explanation of each demodulation mode, shown on hover.
const MODE_DESCRIPTIONS: Record<Mode, string> = {
  WFM: "Wideband FM — commercial FM broadcast (~200 kHz wide). Hi-fi music and stereo.",
  NFM: "Narrowband FM — ham/business/weather voice (~12.5 kHz). The default for VHF/UHF radios.",
  AM: "Amplitude modulation — aircraft band, shortwave broadcast, and CB.",
  USB: "Upper sideband — efficient SSB voice. Standard on HF bands above 10 MHz.",
  LSB: "Lower sideband — efficient SSB voice. Standard on HF bands below 10 MHz.",
  CW: "Continuous wave — Morse code, heard as a tone via a built-in beat oscillator.",
};

// Ten digit positions, high → low: 1 GHz down to 1 Hz (max tunable is 1766 MHz).
const PLACES = [1e9, 1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1e2, 1e1, 1e0];
const N = PLACES.length;

export function Vfo({ state, send }: Props) {
  const tuned = state.centerHz + state.vfoOffset;

  const setTuned = (hz: number) =>
    send({ type: "setFrequency", hz: clamp(hz) - state.vfoOffset });

  const bump = (place: number, dir: number) => setTuned(tuned + place * dir);

  // Overwrite the digit at `place` with `digit` (0–9), leaving the rest alone.
  const setDigit = (place: number, digit: number) => {
    const current = Math.floor(tuned / place) % 10;
    setTuned(tuned + (digit - current) * place);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        <DigitReadout tuned={tuned} onBump={bump} onSetDigit={setDigit} />

        <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
          <span>
            center{" "}
            <span className="text-foreground/70">
              {(state.centerHz / 1e6).toFixed(4)}
            </span>{" "}
            MHz
          </span>
          <span className="text-border">|</span>
          <span>
            offset{" "}
            <span className="text-foreground/70">
              {state.vfoOffset >= 0 ? "+" : "−"}
              {Math.abs(state.vfoOffset / 1e3).toFixed(2)}
            </span>{" "}
            kHz
          </span>
          {state.vfoOffset !== 0 && (
            <button
              onClick={() => send({ type: "setVfoOffset", hz: 0 })}
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              title="Move the dongle center onto the VFO, then zero the offset"
            >
              <Crosshair className="size-3" /> center on VFO
            </button>
          )}
        </div>
      </div>

      <ToggleGroup
        type="single"
        spacing={0}
        value={state.mode}
        onValueChange={(v) => v && send({ type: "setMode", mode: v as Mode })}
        variant="outline"
        className="shrink-0"
        aria-label="Demodulation mode"
      >
        {MODES.map((m) => (
          <Tooltip key={m}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={m}
                className="px-3 font-mono text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {m}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{MODE_DESCRIPTIONS[m]}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
}

// --- digit readout with per-digit steppers / wheel / keyboard --------------

function DigitReadout({
  tuned,
  onBump,
  onSetDigit,
}: {
  tuned: number;
  onBump: (place: number, dir: number) => void;
  onSetDigit: (place: number, digit: number) => void;
}) {
  const digits = String(Math.round(tuned)).padStart(N, "0").split("");
  const firstSig = Math.max(0, digits.findIndex((d) => d !== "0"));

  return (
    <div
      role="group"
      aria-label={`Tuned frequency ${(tuned / 1e6).toFixed(6)} megahertz. Focus a digit and type 0–9, or use the arrow keys.`}
      className="group/readout flex select-none items-end font-mono text-2xl leading-none font-semibold tabular-nums sm:text-[1.75rem]"
    >
      {digits.map((d, i) => {
        const place = PLACES[i]!;
        const sep = i > 0 && (N - i) % 3 === 0;
        const lead = i < firstSig;
        return (
          <span key={i} className="flex items-end">
            {sep && <span aria-hidden className="inline-block w-[0.22em]" />}
            <Digit
              value={d}
              dim={lead}
              onStep={(dir) => onBump(place, dir)}
              onSet={(digit) => onSetDigit(place, digit)}
              title={`${formatPlace(place)} — type 0–9, scroll, or use ▲▼`}
            />
          </span>
        );
      })}
      <span className="ml-1.5 self-center pb-[0.08em] text-xs font-medium text-muted-foreground">
        Hz
      </span>
    </div>
  );
}

function Digit({
  value,
  dim,
  onStep,
  onSet,
  title,
}: {
  value: string;
  dim: boolean;
  onStep: (dir: number) => void;
  onSet: (digit: number) => void;
  title: string;
}) {
  // Move focus to the digit `delta` places to the right (or left if negative).
  const focusSibling = (el: HTMLElement, delta: number) => {
    const all = el
      .closest("[role=group]")
      ?.querySelectorAll<HTMLButtonElement>("[data-digit]");
    if (!all) return;
    const idx = Array.prototype.indexOf.call(all, el);
    all[idx + delta]?.focus();
  };

  return (
    <span className="group/digit relative">
      <Stepper dir={1} onClick={() => onStep(1)} className="top-0 -translate-y-full" />
      <button
        data-digit
        title={title}
        onWheel={(e) => onStep(e.deltaY < 0 ? 1 : -1)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onStep(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onStep(-1);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            focusSibling(e.currentTarget, e.key === "ArrowLeft" ? -1 : 1);
          } else if (/^[0-9]$/.test(e.key)) {
            // Type a digit in place, then advance to the next digit (like a field).
            e.preventDefault();
            onSet(Number(e.key));
            focusSibling(e.currentTarget, 1);
          }
        }}
        className={`px-[0.04em] tabular-nums outline-none transition-colors group-hover/digit:bg-primary/15 group-hover/digit:text-primary focus-visible:bg-primary/15 focus-visible:text-primary ${
          dim ? "text-muted-foreground/30" : "text-foreground"
        }`}
      >
        {value}
      </button>
      <Stepper dir={-1} onClick={() => onStep(-1)} className="bottom-0 translate-y-full" />
    </span>
  );
}

function Stepper({
  dir,
  onClick,
  className,
}: {
  dir: 1 | -1;
  onClick: () => void;
  className: string;
}) {
  const Icon = dir === 1 ? ChevronUp : ChevronDown;
  return (
    <button
      tabIndex={-1}
      aria-hidden
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute left-1/2 flex h-4 w-full -translate-x-1/2 items-center justify-center text-primary opacity-0 transition-opacity group-hover/digit:opacity-100 ${className}`}
    >
      <Icon className="size-3.5" strokeWidth={2.5} />
    </button>
  );
}

// --- helpers ---------------------------------------------------------------

function clamp(hz: number): number {
  return Math.min(LIMITS.MAX_HZ, Math.max(LIMITS.MIN_HZ, Math.round(hz)));
}

function formatPlace(hz: number): string {
  if (hz >= 1e6) return `${hz / 1e6} MHz step`;
  if (hz >= 1e3) return `${hz / 1e3} kHz step`;
  return `${hz} Hz step`;
}
