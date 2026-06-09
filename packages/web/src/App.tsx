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
import { AdsbPanel, RefControls, AircraftDetail } from "@/components/AdsbPanel";
import { distanceNm } from "@/lib/geo";
import { AisPanel } from "@/components/AisPanel";
import { AprsPanel } from "@/components/AprsPanel";
import { Section } from "@/components/Controls";
import { IsmPanel } from "@/components/IsmPanel";
import { IsmConsole } from "@/components/IsmConsole";
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
  Map as MapIcon,
  Plane,
  RadioReceiver,
  RadioTower,
  Ship,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

// OpenLayers is heavy; only load the map when the tracking view is opened.
const AdsbMap = lazy(() =>
  import("@/components/AdsbMap").then((m) => ({ default: m.AdsbMap })),
);

type View = "spectrum" | "track" | "ism";
type MapLayer = "adsb" | "ais" | "aprs";
type Layers = Record<MapLayer, boolean>;

export default function App() {
  const radio = useRadio();
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const [audioRunning, setAudioRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [view, setView] = useState<View>("spectrum");
  const [layers, setLayers] = useState<Layers>(loadLayers);
  const [selected, setSelected] = useState<string | null>(null);
  const [ref, setRef] = useState<{ lat: number; lon: number } | null>(loadRef);
  const [display, setDisplay] = useState<DisplaySettings>(loadDisplay);
  const bm = useBookmarks();

  const state = radio.state ?? DEFAULT_STATE;

  // The selected aircraft, surfaced as a floating detail card over the map.
  const selAircraft =
    view === "track" && layers.adsb && selected
      ? radio.aircraft.find((a) => a.icao === selected)
      : undefined;
  const selDist =
    selAircraft && ref && selAircraft.lat != null
      ? distanceNm(ref.lat, ref.lon, selAircraft.lat, selAircraft.lon!)
      : null;

  const updateDisplay = (next: DisplaySettings) => {
    setDisplay(next);
    saveDisplay(next);
  };

  const sendLayer = (l: MapLayer, on: boolean) => {
    if (l === "adsb") radio.send({ type: "setAdsb", on });
    else if (l === "ais") radio.send({ type: "setAis", on });
    else radio.send({ type: "setAprs", on });
  };

  // Push every layer's enabled state to the server (it round-robins the dongle
  // across the enabled bands and shows them together on the map).
  const activateLayers = (ls: Layers) => {
    sendLayer("adsb", ls.adsb);
    sendLayer("ais", ls.ais);
    sendLayer("aprs", ls.aprs);
  };

  const allLayersOff = () => {
    sendLayer("adsb", false);
    sendLayer("ais", false);
    sendLayer("aprs", false);
  };

  const switchView = (v: View) => {
    setView(v);
    setSelected(null);
    if (v === "track") {
      radio.send({ type: "setIsm", on: false });
      activateLayers(layers);
    } else if (v === "ism") {
      allLayersOff();
      radio.send({ type: "setIsm", on: true });
    } else {
      // Spectrum: leave every decode mode.
      allLayersOff();
      radio.send({ type: "setIsm", on: false });
    }
  };

  // Toggle one map layer on/off (layers display together).
  const toggleLayer = (l: MapLayer) => {
    const next = { ...layers, [l]: !layers[l] };
    setLayers(next);
    saveLayers(next);
    sendLayer(l, next[l]);
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
          {view === "track" ? (
            <>
              <div className="border-b p-2">
                <LayerToggle
                  layers={layers}
                  activeLayer={state.activeLayer}
                  onToggle={toggleLayer}
                />
              </div>
              <Section title="Receiver location" defaultOpen={!ref}>
                <RefControls
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                  onSetRef={setReceiverRef}
                  hasRef={ref != null}
                />
              </Section>
              {!layers.adsb && !layers.ais && !layers.aprs && (
                <p className="px-4 py-3 text-[11px] text-muted-foreground">
                  No layers enabled. Turn on Aircraft, Ships or APRS above to
                  start decoding.
                </p>
              )}
              {layers.adsb && (
                <AdsbPanel
                  aircraft={radio.aircraft}
                  messageRate={radio.messageRate}
                  selected={selected}
                  onSelect={setSelected}
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                  onSetRef={setReceiverRef}
                  hideRef
                />
              )}
              {layers.ais && (
                <AisPanel
                  vessels={radio.vessels}
                  messageRate={radio.aisMessageRate}
                  framesSeen={radio.aisFramesSeen}
                  selected={selected}
                  onSelect={setSelected}
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                  onSetRef={setReceiverRef}
                  hideRef
                />
              )}
              {layers.aprs && (
                <AprsPanel
                  stations={radio.stations}
                  messageRate={radio.aprsMessageRate}
                  framesSeen={radio.aprsFramesSeen}
                  selected={selected}
                  onSelect={setSelected}
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                  onSetRef={setReceiverRef}
                  hideRef
                />
              )}
            </>
          ) : view === "ism" ? (
            <IsmPanel
              stats={radio.ismStats}
              ismFreqHz={state.ismFreqHz}
              send={radio.send}
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
              <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>
                  {[
                    layers.adsb && `${radio.aircraft.length} aircraft`,
                    layers.ais && `${radio.vessels.length} ships`,
                    layers.aprs && `${radio.stations.length} stations`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "no layers enabled"}
                </span>
                {state.activeLayer && (
                  <span className="flex items-center gap-1 text-primary/80">
                    <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                    {LAYER_LABEL[state.activeLayer]}
                  </span>
                )}
              </span>
            )}
            {view === "ism" && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {radio.ismStats?.decoded ?? 0} decoded ·{" "}
                {radio.ismStats?.bursts ?? 0} bursts
              </span>
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
          ) : view === "track" ? (
            <div className="relative min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading map…
                  </div>
                }
              >
                <AdsbMap
                  aircraft={layers.adsb ? radio.aircraft : []}
                  vessels={layers.ais ? radio.vessels : []}
                  stations={layers.aprs ? radio.stations : []}
                  selected={selected}
                  onSelect={setSelected}
                  refLat={ref?.lat ?? null}
                  refLon={ref?.lon ?? null}
                />
              </Suspense>
              {selAircraft && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-end justify-end p-4">
                  <div className="pointer-events-auto">
                    <AircraftDetail
                      key={selAircraft.icao}
                      report={selAircraft}
                      dist={selDist}
                      onClose={() => setSelected(null)}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <IsmConsole
                events={radio.ismEvents}
                freqHz={radio.ismStats?.freqHz ?? state.ismFreqHz}
              />
            </div>
          )}
        </main>
      </div>

      <StatusBar
        state={state}
        audioRunning={audioRunning}
        view={view}
        layers={layers}
      />
    </div>
  );
}

const LAYER_LABEL: Record<MapLayer, string> = {
  adsb: "ADS-B",
  ais: "AIS",
  aprs: "APRS",
};

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

const LAYERS_KEY = "sdr.map.layers";
const DEFAULT_LAYERS: Layers = { adsb: true, ais: false, aprs: false };

function loadLayers(): Layers {
  try {
    const v = localStorage.getItem(LAYERS_KEY);
    if (v) return { ...DEFAULT_LAYERS, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYERS;
}

function saveLayers(l: Layers) {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(l));
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
    { id: "track", label: "Map", icon: MapIcon },
    { id: "ism", label: "ISM 433", icon: RadioReceiver },
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

/**
 * Multi-select map layers. Each is independently on/off; the server round-robins
 * the dongle across the enabled bands and the map shows them together. A pulsing
 * dot marks the band being sampled right now.
 */
function LayerToggle({
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
            ? "Decoding ISM-band OOK · rtl_433-style pulse analysis"
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
