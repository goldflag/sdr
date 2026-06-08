import type { ReactNode } from "react";
import {
  type ClientMessage,
  type DeviceInfo,
  type Mode,
  type RadioState,
  DIRECT_SAMPLING,
  LIMITS,
  MODES,
  SAMPLE_RATES,
} from "@sdr/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SignalState } from "@/lib/ws";
import { Volume2, Radio as RadioIcon } from "lucide-react";

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

export function Controls(p: Props) {
  const { state, deviceInfo, signal, send } = p;
  const gains = deviceInfo?.gains ?? [];
  const [bwMin, bwMax, bwStep] = BW_RANGE[state.mode];

  return (
    <div className="flex flex-col gap-3">
      {/* Mode + S-meter */}
      <Card>
        <CardHeader>
          <CardTitle>Mode</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ToggleGroup
            type="single"
            value={state.mode}
            onValueChange={(v) => v && send({ type: "setMode", mode: v as Mode })}
            className="flex-wrap"
          >
            {MODES.map((m) => (
              <ToggleGroupItem key={m} value={m}>
                {m}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <SMeter signal={signal} />
        </CardContent>
      </Card>

      {/* Audio */}
      <Card>
        <CardHeader>
          <CardTitle>Audio</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!p.audioRunning && (
            <button
              onClick={p.onEnableAudio}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Volume2 className="size-4" /> Enable audio
            </button>
          )}
          <Row label={`Volume ${Math.round(p.volume * 100)}%`}>
            <Slider
              value={[p.volume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={([v]) => p.onVolume(v ?? 0)}
            />
          </Row>
          <Row label={`Bandwidth ${(state.bandwidth / 1000).toFixed(1)} kHz`}>
            <Slider
              value={[state.bandwidth]}
              min={bwMin}
              max={bwMax}
              step={bwStep}
              onValueChange={([v]) =>
                v != null && send({ type: "setBandwidth", hz: v })
              }
            />
          </Row>
          <SquelchRow state={state} signal={signal} send={send} />
        </CardContent>
      </Card>

      {/* Gain */}
      <Card>
        <CardHeader>
          <CardTitle>Gain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label>Auto (tuner AGC)</Label>
            <Switch
              checked={state.gainMode === "auto"}
              onCheckedChange={(on) =>
                send({ type: "setGain", mode: on ? "auto" : "manual", db: state.gainDb })
              }
            />
          </div>
          {state.gainMode === "manual" && gains.length > 0 && (
            <Row label={`Manual gain ${state.gainDb.toFixed(1)} dB`}>
              <Slider
                value={[nearestGainIndex(gains, state.gainDb)]}
                min={0}
                max={gains.length - 1}
                step={1}
                onValueChange={([i]) =>
                  i != null &&
                  send({ type: "setGain", mode: "manual", db: gains[i]! })
                }
              />
            </Row>
          )}
        </CardContent>
      </Card>

      {/* Device */}
      <Card>
        <CardHeader>
          <CardTitle>Device — {deviceInfo?.tunerName ?? "no dongle"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Row label="Sample rate">
            <Select
              value={String(state.sampleRate)}
              onValueChange={(v) => send({ type: "setSampleRate", hz: Number(v) })}
            >
              <SelectTrigger>
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
          </Row>
          <Row label="Direct sampling (HF below 24 MHz)">
            <Select
              value={String(state.directSampling)}
              onValueChange={(v) =>
                send({
                  type: "setDirectSampling",
                  value: Number(v) as 0 | 1 | 2,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={String(DIRECT_SAMPLING.OFF)}>
                  Off (VHF/UHF)
                </SelectItem>
                <SelectItem value={String(DIRECT_SAMPLING.Q_BRANCH)}>
                  Q-branch (HF)
                </SelectItem>
                <SelectItem value={String(DIRECT_SAMPLING.I_BRANCH)}>
                  I-branch
                </SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label={`Frequency correction ${state.ppm} ppm`}>
            <Slider
              value={[state.ppm]}
              min={-100}
              max={100}
              step={1}
              onValueChange={([v]) => v != null && send({ type: "setPpm", ppm: v })}
            />
          </Row>
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <RadioIcon className="size-3.5" /> Bias tee (4.5V)
            </Label>
            <Switch
              checked={state.biasTee}
              onCheckedChange={(on) => send({ type: "setBiasTee", on })}
            />
          </div>
          {state.biasTee && (
            <p className="text-[11px] text-destructive">
              ⚠ 4.5V on the antenna port — only with a compatible LNA/antenna.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="px-1 text-[11px] text-muted-foreground">
        Tunable {(LIMITS.MIN_HZ / 1e6).toFixed(1)}–
        {(LIMITS.MAX_HZ / 1e6).toFixed(0)} MHz · click the spectrum to set the
        VFO · scroll the digits to tune.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SquelchRow({
  state,
  signal,
  send,
}: {
  state: RadioState;
  signal: SignalState | null;
  send: (m: ClientMessage) => void;
}) {
  const enabled = state.squelchDb != null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>
          Squelch{" "}
          {enabled ? `${state.squelchDb!.toFixed(0)} dB` : "off"}
          {signal && (
            <span
              className={`ml-2 ${signal.squelchOpen ? "text-primary" : "text-muted-foreground/50"}`}
            >
              ●
            </span>
          )}
        </Label>
        <Switch
          checked={enabled}
          onCheckedChange={(on) =>
            send({ type: "setSquelch", db: on ? -40 : null })
          }
        />
      </div>
      {enabled && (
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
  );
}

function SMeter({ signal }: { signal: SignalState | null }) {
  const db = signal?.channelDb ?? -90;
  const pct = Math.min(100, Math.max(0, ((db + 90) / 90) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 font-mono text-[10px] text-muted-foreground">S</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary transition-[width] duration-100"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 text-right font-mono text-[10px] text-muted-foreground">
        {db.toFixed(0)} dB
      </span>
    </div>
  );
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
