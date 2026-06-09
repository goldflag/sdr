import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { DEFAULT_STATE, type RadioState } from "@sdr/shared";
import { useRadio } from "@/lib/ws";
import { PcmPlayer } from "@/audio/pcm-player";
import { SpectrumWaterfall } from "@/components/SpectrumWaterfall";
import { Controls } from "@/components/Controls";
import { Presets } from "@/components/Presets";
import { Bookmarks } from "@/components/Bookmarks";
import { Scanner } from "@/components/Scanner";
import { useBookmarks } from "@/lib/bookmarks";
import { Vfo } from "@/components/Vfo";
import { AdsbPanel } from "@/components/AdsbPanel";
import { AisPanel } from "@/components/AisPanel";
import {
  SpectrumDisplay,
  DEFAULT_DISPLAY,
  type DisplaySettings,
} from "@/components/SpectrumDisplay";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity,
  AlertTriangle,
  AudioWaveform,
  Plane,
  Ship,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

// OpenLayers is heavy; only load the map when the tracking view is opened.
const AdsbMap = lazy(() =>
  import("@/components/AdsbMap").then((m) => ({ default: m.AdsbMap })),
);

type View = "spectrum" | "track";
/** Which decoder feeds the tracking map (the dongle does one band at a time). */
type TrackSource = "adsb" | "ais";

export default function App() {
  const radio = useRadio();
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const [audioRunning, setAudioRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [view, setView] = useState<View>("spectrum");
  const [source, setSource] = useState<TrackSource>("adsb");
  const [selected, setSelected] = useState<string | null>(null);
  const [ref, setRef] = useState<{ lat: number; lon: number } | null>(loadRef);
  const [display, setDisplay] = useState<DisplaySettings>(loadDisplay);
  const bm = useBookmarks();

  const state = radio.state ?? DEFAULT_STATE;

  const updateDisplay = (next: DisplaySettings) => {
    setDisplay(next);
    saveDisplay(next);
  };

  // Activate the decoder for a source (the server auto-disables the other one).
  const activate = (s: TrackSource) => {
    if (s === "adsb") radio.send({ type: "setAdsb", on: true });
    else radio.send({ type: "setAis", on: true });
  };

  const switchView = (v: View) => {
    setView(v);
    if (v === "track") {
      activate(source);
    } else {
      setSelected(null);
      radio.send({ type: "setAdsb", on: false });
      radio.send({ type: "setAis", on: false });
    }
  };

  // Switch which decoder feeds the map while staying in the tracking view.
  const switchSource = (s: TrackSource) => {
    if (s === source) return;
    setSource(s);
    setSelected(null);
    activate(s);
  };

  const setReceiverRef = (lat: number | null, lon: number | null) => {
    const next = lat != null && lon != null ? { lat, lon } : null;
    setRef(next);
    saveRef(next);
  };

  // Keep the server's reference position in sync (also re-sent on reconnect).
  const { send, connected } = radio;
  useEffect(() => {
    send({ type: "setAdsbRef", lat: ref?.lat ?? null, lon: ref?.lon ?? null });
  }, [send, connected, ref]);

  // Pipe audio frames to the player.
  useEffect(
    () => radio.subscribeAudio((f) => playerRef.current?.push(f.pcm)),
    [radio.subscribeAudio],
  );

  // Flush buffered audio when retuning / changing mode to keep latency low.
  useEffect(() => {
    playerRef.current?.flush();
  }, [state.mode, state.centerHz]);

  const enableAudio = async () => {
    await playerRef.current?.init();
    playerRef.current?.setVolume(muted ? 0 : volume);
    setAudioRunning(playerRef.current?.running ?? false);
  };

  // Dragging the slider sets a level and always unmutes.
  const changeVolume = (v: number) => {
    setVolume(v);
    setMuted(false);
    playerRef.current?.setVolume(v);
  };

  // Toggle mute, keeping the slider level so it can be restored.
  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      playerRef.current?.setVolume(next ? 0 : volume);
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {radio.error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" /> {radio.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Control rail — receiver controls, or traffic when in the map view */}
        <aside className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-r bg-sidebar">
          {view === "track" && source === "adsb" ? (
            <AdsbPanel
              aircraft={radio.aircraft}
              messageRate={radio.messageRate}
              selected={selected}
              onSelect={setSelected}
              refLat={ref?.lat ?? null}
              refLon={ref?.lon ?? null}
              onSetRef={setReceiverRef}
            />
          ) : view === "track" && source === "ais" ? (
            <AisPanel
              vessels={radio.vessels}
              messageRate={radio.aisMessageRate}
              framesSeen={radio.aisFramesSeen}
              selected={selected}
              onSelect={setSelected}
              refLat={ref?.lat ?? null}
              refLon={ref?.lon ?? null}
              onSetRef={setReceiverRef}
            />
          ) : (
            <>
              <Presets state={state} send={radio.send} />
              <Scanner
                state={state}
                send={radio.send}
                scan={radio.scan}
                bookmarks={bm.items}
              />
              <Bookmarks state={state} send={radio.send} bm={bm} />
              <Controls
                state={state}
                deviceInfo={radio.deviceInfo}
                signal={radio.signal}
                send={radio.send}
              />
              <SpectrumDisplay display={display} onChange={updateDisplay} />
            </>
          )}
        </aside>

        {/* Main column: view tabs + spectrum/waterfall or live ADS-B map */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b px-4 py-2">
            <ViewTabs view={view} onChange={switchView} />
            {view === "track" && (
              <>
                <SourceToggle source={source} onChange={switchSource} />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {source === "adsb"
                    ? `${radio.aircraft.length} aircraft · ${radio.messageRate} msg/s`
                    : `${radio.vessels.length} vessels · ${radio.aisMessageRate} msg/s`}
                </span>
              </>
            )}
            {view === "spectrum" && (
              <AudioControl
                running={audioRunning}
                volume={volume}
                muted={muted}
                onVolume={changeVolume}
                onToggleMute={toggleMute}
                onEnable={enableAudio}
              />
            )}
          </div>
          {view === "spectrum" ? (
            <>
              <div className="border-b px-4 py-2.5">
                <Vfo state={state} send={radio.send} />
              </div>
              <div className="min-h-0 flex-1 p-4">
                <SpectrumWaterfall
                  subscribeFft={radio.subscribeFft}
                  state={state}
                  display={display}
                  onTune={(hz) => radio.send({ type: "setVfoOffset", hz })}
                  onPassband={(low, high) =>
                    radio.send({ type: "setPassband", low, high })
                  }
                  onNotches={(notches) =>
                    radio.send({ type: "setNotches", notches })
                  }
                />
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading map…
                  </div>
                }
              >
                <AdsbMap
                  key={source}
                  aircraft={source === "adsb" ? radio.aircraft : []}
                  vessels={source === "ais" ? radio.vessels : []}
                  selected={selected}
                  onSelect={setSelected}
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                />
              </Suspense>
            </div>
          )}
        </main>
      </div>

      <StatusBar
        state={state}
        audioRunning={audioRunning}
        view={view}
        source={source}
      />
    </div>
  );
}

const REF_KEY = "sdr.adsb.ref";

function loadRef(): { lat: number; lon: number } | null {
  try {
    const v = localStorage.getItem(REF_KEY);
    if (!v) return null;
    const r = JSON.parse(v);
    return typeof r?.lat === "number" && typeof r?.lon === "number" ? r : null;
  } catch {
    return null;
  }
}

function saveRef(r: { lat: number; lon: number } | null) {
  try {
    if (r) localStorage.setItem(REF_KEY, JSON.stringify(r));
    else localStorage.removeItem(REF_KEY);
  } catch {
    /* storage unavailable */
  }
}

const DISPLAY_KEY = "sdr.display";

function loadDisplay(): DisplaySettings {
  try {
    const v = localStorage.getItem(DISPLAY_KEY);
    if (v) return { ...DEFAULT_DISPLAY, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
  return DEFAULT_DISPLAY;
}

function saveDisplay(d: DisplaySettings) {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable */
  }
}

function ViewTabs({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  const tabs: { id: View; label: string; icon: typeof Plane }[] = [
    { id: "spectrum", label: "Spectrum", icon: AudioWaveform },
    { id: "track", label: "ADS-B / AIS", icon: Plane },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Picks which decoder (aircraft / ships) drives the tracking map. */
function SourceToggle({
  source,
  onChange,
}: {
  source: TrackSource;
  onChange: (s: TrackSource) => void;
}) {
  const opts: { id: TrackSource; label: string; icon: typeof Plane }[] = [
    { id: "adsb", label: "Aircraft", icon: Plane },
    { id: "ais", label: "Ships", icon: Ship },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = source === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Compact audio output control for the view toolbar. */
function AudioControl({
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

function StatusBar({
  state,
  audioRunning,
  view,
  source,
}: {
  state: RadioState;
  audioRunning: boolean;
  view: View;
  source: TrackSource;
}) {
  const isAdsb = view === "track" && source === "adsb";
  const isAis = view === "track" && source === "ais";
  return (
    <footer className="flex items-center justify-between gap-4 border-t bg-sidebar px-5 py-1.5 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Activity className="size-3 text-primary" />
        {isAdsb
          ? "Decoding Mode S extended squitter at 1090 MHz · markers update live"
          : isAis
            ? "Decoding AIS GMSK on both channels at 162 MHz · markers update live"
            : "Click to tune · scroll to zoom · drag filter edges · ⌥-click to notch"}
      </span>
      <div className="flex items-center gap-4">
        {isAdsb ? (
          <Stat label="FREQ" value="1090.000M" />
        ) : isAis ? (
          <Stat label="FREQ" value="162.000M" />
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
