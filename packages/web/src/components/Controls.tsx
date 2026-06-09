import { useState, type ReactNode } from "react";
import {
  type AgcMode,
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  AGC_MODES,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SignalState } from "@/lib/ws";
import { Volume2, AlertTriangle, ChevronRight, Info } from "lucide-react";

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
          info="Width of the channel filter. Narrower rejects more adjacent interference but thins the audio; wider sounds fuller but lets in more noise and neighbouring signals."
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

        <div className="flex items-baseline justify-between">
          <Label className="flex items-center gap-1 text-xs">
            Passband
            <InfoTip>
              The filter's low and high edges relative to the tuned frequency.
              Drag either edge on the spectrum to shape it asymmetrically (e.g.
              to dodge interference on one side); ⇧-drag to slide both together
              (IF shift).
            </InfoTip>
          </Label>
          <span className="font-mono text-[11px] text-foreground/70">
            {fmtEdge(state.filterLow)} … {fmtEdge(state.filterHigh)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Drag the filter edges on the spectrum (⇧-drag to shift); ⌥-click to
          add or remove a notch.
        </p>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1">
                Squelch
                <InfoTip>
                  Mutes the audio until channel power exceeds this threshold, so
                  you don't sit listening to hiss between transmissions. Raise it
                  just above the idle noise level.
                </InfoTip>
              </span>
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

      <Section title="Noise &amp; dynamics">
        <SwitchRow
          label="Noise reduction"
          info="Adaptive (LMS) suppression of steady background hiss while keeping voice, tones and CW intact. Higher strength removes more noise but can sound watery on weak signals."
          value={state.nrOn ? `${Math.round(state.nrLevel * 100)}%` : "off"}
          checked={state.nrOn}
          onCheckedChange={(on) =>
            send({ type: "setNr", on, level: state.nrLevel })
          }
        />
        {state.nrOn && (
          <Slider
            value={[state.nrLevel]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={([v]) =>
              v != null && send({ type: "setNr", on: true, level: v })
            }
          />
        )}

        <SwitchRow
          label="Noise blanker"
          info="Removes short impulse noise — ignition crackle, power-line arcing, electric-fence ticks — before demodulation. A lower threshold blanks more aggressively (but can dull strong signals)."
          value={state.nbOn ? `${state.nbThreshold.toFixed(1)}×` : "off"}
          checked={state.nbOn}
          onCheckedChange={(on) =>
            send({ type: "setNb", on, threshold: state.nbThreshold })
          }
        />
        {state.nbOn && (
          <Slider
            value={[state.nbThreshold]}
            min={2}
            max={12}
            step={0.5}
            onValueChange={([v]) =>
              v != null && send({ type: "setNb", on: true, threshold: v })
            }
          />
        )}

        <Field
          label="Audio AGC"
          info="Automatically evens out loudness as signals fade or vary, like a receiver's audio AGC. Fast reacts quickly (good for SSB/CW); Slow is smoother for voice. Each preset sets the attack/decay/hang timing. Separate from the tuner's RF gain."
        >
          <Select
            value={state.agc}
            onValueChange={(v) => send({ type: "setAgc", mode: v as AgcMode })}
          >
            <SelectTrigger className={SELECT_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGC_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m[0]!.toUpperCase() + m.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
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
          <Label className="flex items-center gap-1 text-xs">
            Tuner AGC
            <InfoTip>
              Lets the dongle set its own front-end RF gain automatically. Switch
              off to set the gain by hand, which usually gives the best
              signal-to-noise on a known signal.
            </InfoTip>
          </Label>
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
          <Field
            label="Gain"
            value={`${state.gainDb.toFixed(1)} dB`}
            info="Front-end RF amplification. Higher gain pulls in weak signals, but too much overloads the tuner on strong ones, creating spurs and distortion across the band."
          >
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
        <Field
          label="Sample rate"
          info="How much bandwidth the dongle captures at once — this is the full width of the spectrum/waterfall. Higher shows more at once and allows wider FM, but uses more CPU."
        >
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

        <Field
          label="Direct sampling"
          hint="HF reception below ~24 MHz"
          info="Bypasses the tuner so the RTL-SDR V3 can receive HF (shortwave, below ~24 MHz). Use Q-branch for HF; leave Off for normal VHF/UHF reception."
        >
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

        <Field
          label="Frequency correction"
          value={`${state.ppm} ppm`}
          info="Compensates for the dongle's crystal error. If stations appear slightly off their known frequency, nudge this until they line up."
        >
          <Slider
            value={[state.ppm]}
            min={-100}
            max={100}
            step={1}
            onValueChange={([v]) => v != null && send({ type: "setPpm", ppm: v })}
          />
        </Field>

        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1 text-xs">
            Bias tee (4.5 V)
            <InfoTip>
              Sends 4.5 V up the antenna cable to power an external LNA or active
              antenna. Leave off unless your hardware needs it — never enable it
              with a plain antenna or a transmitter connected.
            </InfoTip>
          </Label>
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
  info,
  children,
}: {
  label: string;
  value?: string;
  hint?: string;
  info?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <Label className="flex items-center gap-1 text-xs">
          {label}
          {info && <InfoTip>{info}</InfoTip>}
        </Label>
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

/** Small "?" affordance that reveals an explanatory tooltip on hover/focus. */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          className="inline-flex text-muted-foreground/45 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        >
          <Info className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

function SwitchRow({
  label,
  value,
  checked,
  onCheckedChange,
  info,
}: {
  label: string;
  value: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  info?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <Label className="flex items-center gap-1 text-xs">
        {label}
        {info && <InfoTip>{info}</InfoTip>}
      </Label>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {value}
        </span>
        <Switch size="sm" checked={checked} onCheckedChange={onCheckedChange} />
      </div>
    </div>
  );
}

/** Format a filter-edge offset (Hz from the VFO) compactly, e.g. "+2.7k". */
function fmtEdge(hz: number): string {
  const sign = hz > 0 ? "+" : hz < 0 ? "−" : "";
  const a = Math.abs(hz);
  const s = a >= 1000 ? `${(a / 1000).toFixed(a % 1000 ? 1 : 0)}k` : `${a}`;
  return `${sign}${s}`;
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
