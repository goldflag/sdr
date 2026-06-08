import { useState, type ReactNode } from "react";
import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  DIRECT_SAMPLING,
  SAMPLE_RATES,
} from "@sdr/shared";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { SignalState } from "@/lib/ws";
import { Volume2, AlertTriangle, ChevronRight } from "lucide-react";

interface Props {
  state: RadioState;
  deviceInfo: DeviceInfo | null;
  signal: SignalState | null;
  send: (msg: ClientMessage) => void;
  volume: number;
  onVolume: (v: number) => void;
  audioRunning: boolean;
  onEnableAudio: () => void;
}

const BW_RANGE: Record<Mode, [number, number, number]> = {
  // [min, max, step] Hz
  WFM: [50_000, 250_000, 5_000],
  NFM: [5_000, 25_000, 500],
  AM: [3_000, 20_000, 500],
  USB: [1_200, 4_000, 100],
  LSB: [1_200, 4_000, 100],
  CW: [100, 2_000, 50],
};

const SELECT_TRIGGER = "h-7 w-full px-2 text-xs";

export function Controls(p: Props) {
  const { state, deviceInfo, signal, send } = p;
  const gains = deviceInfo?.gains ?? [];
  const [bwMin, bwMax, bwStep] = BW_RANGE[state.mode];
  const squelchOn = state.squelchDb != null;

  return (
    <div className="flex flex-col">
      <Section title="Signal">
        <SMeter signal={signal} />
      </Section>

      <Section title="Channel">
        <Field
          label="Bandwidth"
          value={`${(state.bandwidth / 1000).toFixed(state.bandwidth < 10_000 ? 2 : 1)} kHz`}
        >
          <Slider
            value={[state.bandwidth]}
            min={bwMin}
            max={bwMax}
            step={bwStep}
            onValueChange={([v]) =>
              v != null && send({ type: "setBandwidth", hz: v })
            }
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2 text-xs">
              Squelch
              <span
                className={`size-1.5 rounded-full transition-colors ${
                  signal?.squelchOpen
                    ? "bg-primary shadow-[0_0_6px_var(--primary)]"
                    : "bg-muted-foreground/30"
                }`}
                title={signal?.squelchOpen ? "open" : "closed"}
              />
            </Label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                {squelchOn ? `${state.squelchDb!.toFixed(0)} dB` : "off"}
              </span>
              <Switch
                size="sm"
                checked={squelchOn}
                onCheckedChange={(on) =>
                  send({ type: "setSquelch", db: on ? -40 : null })
                }
              />
            </div>
          </div>
          {squelchOn && (
            <Slider
              value={[state.squelchDb!]}
              min={-90}
              max={0}
              step={1}
              onValueChange={([v]) =>
                v != null && send({ type: "setSquelch", db: v })
              }
            />
          )}
        </div>
      </Section>

      <Section title="Audio">
        {p.audioRunning ? (
          <Field label="Volume" value={`${Math.round(p.volume * 100)}%`}>
            <Slider
              value={[p.volume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={([v]) => p.onVolume(v ?? 0)}
            />
          </Field>
        ) : (
          <Button onClick={p.onEnableAudio} className="w-full" size="sm">
            <Volume2 /> Enable audio output
          </Button>
        )}
      </Section>

      <Section title="Gain">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Tuner AGC</Label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              {state.gainMode === "auto" ? "auto" : "manual"}
            </span>
            <Switch
              size="sm"
              checked={state.gainMode === "auto"}
              onCheckedChange={(on) =>
                send({
                  type: "setGain",
                  mode: on ? "auto" : "manual",
                  db: state.gainDb,
                })
              }
            />
          </div>
        </div>
        {state.gainMode === "manual" && gains.length > 0 && (
          <Field label="Gain" value={`${state.gainDb.toFixed(1)} dB`}>
            <Slider
              value={[nearestGainIndex(gains, state.gainDb)]}
              min={0}
              max={gains.length - 1}
              step={1}
              onValueChange={([i]) =>
                i != null && send({ type: "setGain", mode: "manual", db: gains[i]! })
              }
            />
          </Field>
        )}
        {state.gainMode === "manual" && gains.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Gain steps unavailable until a tuner is detected.
          </p>
        )}
      </Section>

      <Section title="Device" aside={deviceInfo?.tunerName ?? "no dongle"}>
        <Field label="Sample rate">
          <Select
            value={String(state.sampleRate)}
            onValueChange={(v) => send({ type: "setSampleRate", hz: Number(v) })}
          >
            <SelectTrigger className={SELECT_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SAMPLE_RATES.map((r) => (
                <SelectItem key={r} value={String(r)}>
                  {(r / 1e6).toFixed(3)} MSPS
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Direct sampling" hint="HF reception below ~24 MHz">
          <Select
            value={String(state.directSampling)}
            onValueChange={(v) =>
              send({ type: "setDirectSampling", value: Number(v) as 0 | 1 | 2 })
            }
          >
            <SelectTrigger className={SELECT_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={String(DIRECT_SAMPLING.OFF)}>
                Off — VHF / UHF
              </SelectItem>
              <SelectItem value={String(DIRECT_SAMPLING.Q_BRANCH)}>
                Q-branch — HF
              </SelectItem>
              <SelectItem value={String(DIRECT_SAMPLING.I_BRANCH)}>
                I-branch
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label="Frequency correction" value={`${state.ppm} ppm`}>
          <Slider
            value={[state.ppm]}
            min={-100}
            max={100}
            step={1}
            onValueChange={([v]) => v != null && send({ type: "setPpm", ppm: v })}
          />
        </Field>

        <div className="flex items-center justify-between">
          <Label className="text-xs">Bias tee (4.5 V)</Label>
          <Switch
            size="sm"
            checked={state.biasTee}
            onCheckedChange={(on) => send({ type: "setBiasTee", on })}
          />
        </div>
        {state.biasTee && (
          <p className="flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            4.5 V is on the antenna port. Use only with a compatible powered LNA
            or antenna.
          </p>
        )}
      </Section>
    </div>
  );
}

// --- panel primitives ------------------------------------------------------

const COLLAPSE_KEY = "sdr.panel.collapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistCollapsed(title: string, collapsed: boolean) {
  try {
    const map = readCollapsed();
    map[title] = collapsed;
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable; collapse stays in-memory only */
  }
}

export function Section({
  title,
  aside,
  defaultOpen = true,
  children,
}: {
  title: string;
  aside?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const stored = readCollapsed()[title];
    return stored == null ? defaultOpen : !stored;
  });

  const toggle = () => {
    setOpen((o) => {
      persistCollapsed(title, o); // about to be the opposite → store the new collapsed state
      return !o;
    });
  };

  return (
    <section className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <h2 className="flex-1 text-[11px] font-semibold tracking-wide text-foreground/70">
          {title}
        </h2>
        {aside && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {aside}
          </span>
        )}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2.5 px-3 pb-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function Field({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {value && (
          <span className="font-mono text-[11px] text-foreground/70">
            {value}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// --- segmented S-meter -----------------------------------------------------

const SEG_COUNT = 22;

function SMeter({ signal }: { signal: SignalState | null }) {
  const db = signal?.channelDb ?? -120;
  // Map roughly -110..-10 dB of channel power onto the meter.
  const frac = clamp01((db + 110) / 100);
  const lit = Math.round(frac * SEG_COUNT);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <div className="flex h-5 flex-1 items-stretch gap-px">
          {Array.from({ length: SEG_COUNT }, (_, i) => {
            const on = i < lit;
            // Top fifth of the scale reads "strong" in warm amber.
            const hot = i >= SEG_COUNT - 5;
            return (
              <span
                key={i}
                className={
                  on
                    ? hot
                      ? "flex-1 bg-[oklch(0.78_0.16_70)]"
                      : "flex-1 bg-primary"
                    : "flex-1 bg-muted"
                }
              />
            );
          })}
        </div>
        <span className="w-14 text-right font-mono text-xs tabular-nums text-foreground">
          {signal ? `${db.toFixed(0)}` : "––"}
          <span className="ml-1 text-[11px] text-muted-foreground">dB</span>
        </span>
      </div>
      <div className="flex justify-between px-px font-mono text-[10px] text-muted-foreground/70">
        <span>S1</span>
        <span>S5</span>
        <span>S9</span>
        <span className="text-[oklch(0.78_0.16_70)]/70">+20</span>
      </div>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function nearestGainIndex(gains: number[], db: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < gains.length; i++) {
    const d = Math.abs(gains[i]! - db);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
