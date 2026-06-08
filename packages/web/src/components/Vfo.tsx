// Tuned-frequency readout and primary tuning control.
//
// Three ways to tune, in order of directness:
//   1. Click the readout and type a frequency ("100.3", "433.92 MHz", "7100k").
//   2. Hover a digit and use the ▲/▼ steppers, or scroll the wheel over it.
//   3. Keyboard: ArrowUp/Down nudge the active digit, ArrowLeft/Right move it.
//
// The tuned frequency is centerHz + vfoOffset; nudging a digit moves the dongle
// center while preserving the VFO offset, so the signal under the cursor stays put.

import { useLayoutEffect, useRef, useState } from "react";
import { LIMITS, MODES } from "@sdr/shared";
import type { ClientMessage, Mode, RadioState } from "@sdr/shared";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChevronUp, ChevronDown, Crosshair } from "lucide-react";

interface Props {
  state: RadioState;
  send: (msg: ClientMessage) => void;
}

// Ten digit positions, high → low: 1 GHz down to 1 Hz (max tunable is 1766 MHz).
const PLACES = [1e9, 1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1e2, 1e1, 1e0];
const N = PLACES.length;

export function Vfo({ state, send }: Props) {
  const tuned = state.centerHz + state.vfoOffset;
  const [editing, setEditing] = useState(false);

  const setTuned = (hz: number) =>
    send({ type: "setFrequency", hz: clamp(hz) - state.vfoOffset });

  const bump = (place: number, dir: number) => setTuned(tuned + place * dir);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        {editing ? (
          <FrequencyInput
            tuned={tuned}
            onCommit={(hz) => {
              setTuned(hz);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <DigitReadout
            tuned={tuned}
            onBump={bump}
            onEdit={() => setEditing(true)}
          />
        )}

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
          <ToggleGroupItem
            key={m}
            value={m}
            className="px-3 font-mono text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
          >
            {m}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

// --- digit readout with per-digit steppers / wheel / keyboard --------------

function DigitReadout({
  tuned,
  onBump,
  onEdit,
}: {
  tuned: number;
  onBump: (place: number, dir: number) => void;
  onEdit: () => void;
}) {
  const digits = String(Math.round(tuned)).padStart(N, "0").split("");
  const firstSig = Math.max(0, digits.findIndex((d) => d !== "0"));

  return (
    <div
      role="group"
      aria-label={`Tuned frequency ${(tuned / 1e6).toFixed(6)} megahertz. Click to type a frequency.`}
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
              onEdit={onEdit}
              title={`${formatPlace(place)} — scroll, use ▲▼, or click to type`}
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
  onEdit,
  title,
}: {
  value: string;
  dim: boolean;
  onStep: (dir: number) => void;
  onEdit: () => void;
  title: string;
}) {
  return (
    <span className="group/digit relative">
      <Stepper dir={1} onClick={() => onStep(1)} className="top-0 -translate-y-full" />
      <button
        data-digit
        title={title}
        onClick={onEdit}
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
            const all = e.currentTarget
              .closest("[role=group]")
              ?.querySelectorAll<HTMLButtonElement>("[data-digit]");
            if (!all) return;
            const idx = Array.prototype.indexOf.call(all, e.currentTarget);
            const next = all[idx + (e.key === "ArrowLeft" ? -1 : 1)];
            next?.focus();
          } else if (e.key === "Enter") {
            onEdit();
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

// --- free-text frequency entry ---------------------------------------------

function FrequencyInput({
  tuned,
  onCommit,
  onCancel,
}: {
  tuned: number;
  onCommit: (hz: number) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(() => trimZeros((tuned / 1e6).toFixed(6)));

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const hz = parseFreq(value);
    if (hz == null) onCancel();
    else onCommit(hz);
  };

  return (
    <div className="flex items-end gap-2 font-mono text-2xl leading-none font-semibold sm:text-[1.75rem]">
      <input
        ref={ref}
        value={value}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
        className="w-[7ch] min-w-0 bg-transparent tabular-nums text-primary caret-primary outline-none placeholder:text-muted-foreground/40"
        aria-label="Enter frequency in MHz (or add a k / M / G suffix)"
      />
      <span className="self-center pb-[0.08em] text-xs font-medium text-muted-foreground">
        MHz
      </span>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function clamp(hz: number): number {
  return Math.min(LIMITS.MAX_HZ, Math.max(LIMITS.MIN_HZ, Math.round(hz)));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function formatPlace(hz: number): string {
  if (hz >= 1e6) return `${hz / 1e6} MHz step`;
  if (hz >= 1e3) return `${hz / 1e3} kHz step`;
  return `${hz} Hz step`;
}

/**
 * Parse a typed frequency. Accepts suffixes (g/m/k/hz) and bare numbers:
 * a bare number with a decimal point or below 10000 is read as MHz, otherwise Hz.
 * Returns Hz, or null if unparseable.
 */
export function parseFreq(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[, _]/g, "");
  const m = s.match(/^(\d*\.?\d+)(ghz|mhz|khz|hz|g|m|k)?$/);
  if (!m) return null;
  let v = parseFloat(m[1]!);
  if (!isFinite(v)) return null;
  switch (m[2]) {
    case "g":
    case "ghz":
      v *= 1e9;
      break;
    case "m":
    case "mhz":
      v *= 1e6;
      break;
    case "k":
    case "khz":
      v *= 1e3;
      break;
    case "hz":
      break;
    default:
      if (s.includes(".") || v < 10000) v *= 1e6; // bare number → MHz
  }
  return clamp(v);
}
