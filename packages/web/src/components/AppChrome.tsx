// App-shell chrome: the view tabs, the map layer toggle, the toolbar audio
// control, and the bottom status bar. All stateless — App owns the state.

import type { MapLayer, RadioState } from "@sdr/shared";
import type { Layers, View } from "@/lib/ui-store";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity,
  AudioWaveform,
  Map as MapIcon,
  Plane,
  RadioReceiver,
  RadioTower,
  Ship,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

export const LAYER_LABEL: Record<MapLayer, string> = {
  adsb: "ADS-B",
  ais: "AIS",
  aprs: "APRS",
};

export function ViewTabs({
  view,
  onChange,
  ismAvailable,
}: {
  view: View;
  onChange: (v: View) => void;
  ismAvailable: boolean;
}) {
  const tabs: {
    id: View;
    label: string;
    icon: typeof Plane;
    disabled?: boolean;
    reason?: string;
  }[] = [
    { id: "spectrum", label: "Spectrum", icon: AudioWaveform },
    { id: "track", label: "Map", icon: MapIcon },
    {
      id: "ism",
      label: "ISM 433",
      icon: RadioReceiver,
      disabled: !ismAvailable,
      reason: "Requires rtl_433 — install it (e.g. brew install rtl_433) and restart the server to decode ISM sensors.",
    },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = view === t.id;
        const tab = (
          <button
            key={t.id}
            type="button"
            disabled={t.disabled}
            onClick={() => !t.disabled && onChange(t.id)}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              t.disabled
                ? "cursor-not-allowed text-muted-foreground/40"
                : active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {t.label}
          </button>
        );
        if (!t.disabled) return tab;
        // Disabled tab: a disabled <button> emits no pointer events, so wrap it
        // in a span that carries the tooltip trigger and explains why.
        return (
          <Tooltip key={t.id}>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={0}>
                {tab}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.reason}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Multi-select map layers. Each is independently on/off; the server round-robins
 * the dongle across the enabled bands and the map shows them together. A pulsing
 * dot marks the band being sampled right now.
 */
export function LayerToggle({
  layers,
  activeLayer,
  onToggle,
}: {
  layers: Layers;
  activeLayer: MapLayer | null;
  onToggle: (l: MapLayer) => void;
}) {
  const opts: { id: MapLayer; label: string; icon: typeof Plane }[] = [
    { id: "adsb", label: "Aircraft", icon: Plane },
    { id: "ais", label: "Ships", icon: Ship },
    { id: "aprs", label: "APRS", icon: RadioTower },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const on = layers[o.id];
        const live = activeLayer === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onToggle(o.id)}
            aria-pressed={on}
            title={`${o.label} layer ${on ? "on" : "off"}`}
            className={`relative flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              on
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground/70 hover:text-foreground"
            }`}
          >
            {live && (
              <span className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-primary" />
            )}
            <Icon className="size-3" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Compact audio output control for the view toolbar. */
export function AudioControl({
  running,
  volume,
  muted,
  onVolume,
  onToggleMute,
  onEnable,
}: {
  running: boolean;
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onEnable: () => void;
}) {
  if (!running) {
    return (
      <Button
        onClick={onEnable}
        size="sm"
        variant="outline"
        className="ml-auto"
      >
        <Volume2 /> Enable audio
      </Button>
    );
  }
  const silent = muted || volume === 0;
  const Icon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="ml-auto flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            className="inline-flex text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          >
            <Icon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{muted ? "Unmute" : "Mute"}</TooltipContent>
      </Tooltip>
      <Slider
        value={[volume]}
        min={0}
        max={1}
        step={0.01}
        onValueChange={([v]) => onVolume(v ?? 0)}
        aria-label="Volume"
        className="w-24"
      />
      <span
        className={`w-9 text-right font-mono text-[11px] tabular-nums ${
          silent ? "text-muted-foreground" : "text-foreground/70"
        }`}
      >
        {Math.round(volume * 100)}%
      </span>
    </div>
  );
}

export function StatusBar({
  state,
  audioRunning,
  view,
  layers,
}: {
  state: RadioState;
  audioRunning: boolean;
  view: View;
  layers: Layers;
}) {
  const isTrack = view === "track";
  const isIsm = view === "ism";
  const enabledCount = Number(layers.adsb) + Number(layers.ais) + Number(layers.aprs);
  const liveFreqM =
    state.activeLayer === "adsb"
      ? "1090.000"
      : state.activeLayer === "ais"
        ? "162.000"
        : state.activeLayer === "aprs"
          ? "144.390"
          : null;
  return (
    <footer className="flex items-center justify-between gap-4 border-t bg-sidebar px-5 py-1.5 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Activity className="size-3 text-primary" />
        {isTrack
          ? enabledCount > 1
            ? `Time-sharing the dongle across ${enabledCount} bands · markers update as each is sampled`
            : enabledCount === 1
              ? "Decoding one band · markers update live"
              : "No layers enabled — pick Aircraft / Ships / APRS"
          : isIsm
            ? "Decoding ISM-band sensors via rtl_433"
            : "Click to tune · scroll to zoom · drag filter edges · ⌥-click to notch"}
      </span>
      <div className="flex items-center gap-4">
        {isTrack ? (
          <Stat label="FREQ" value={liveFreqM ? `${liveFreqM}M` : "—"} />
        ) : isIsm ? (
          <Stat label="FREQ" value={`${(state.ismFreqHz / 1e6).toFixed(3)}M`} />
        ) : (
          <>
            <Stat label="MODE" value={state.mode} />
            <Stat
              label="BW"
              value={`${(state.bandwidth / 1000).toFixed(1)}k`}
            />
          </>
        )}
        <Stat label="SR" value={`${(state.sampleRate / 1e6).toFixed(3)}M`} />
        <Stat
          label="GAIN"
          value={
            state.gainMode === "auto" ? "AUTO" : `${state.gainDb.toFixed(0)}dB`
          }
        />
        {view === "spectrum" && (
          <Stat label="AUDIO" value={audioRunning ? "ON" : "OFF"} />
        )}
      </div>
    </footer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground/55">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </span>
  );
}
