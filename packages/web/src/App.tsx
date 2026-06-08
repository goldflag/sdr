import { useEffect, useRef, useState } from "react";
import { DEFAULT_STATE, type RadioState } from "@sdr/shared";
import { useRadio } from "@/lib/ws";
import { PcmPlayer } from "@/audio/pcm-player";
import { SpectrumWaterfall } from "@/components/SpectrumWaterfall";
import { Controls } from "@/components/Controls";
import { Presets } from "@/components/Presets";
import { Bookmarks } from "@/components/Bookmarks";
import { Vfo } from "@/components/Vfo";
import { AdsbMap } from "@/components/AdsbMap";
import { AdsbPanel } from "@/components/AdsbPanel";
import { Activity, AlertTriangle, AudioWaveform, Plane } from "lucide-react";

type View = "spectrum" | "adsb";

export default function App() {
  const radio = useRadio();
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const [audioRunning, setAudioRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [view, setView] = useState<View>("spectrum");

  const state = radio.state ?? DEFAULT_STATE;

  const switchView = (v: View) => {
    setView(v);
    radio.send({ type: "setAdsb", on: v === "adsb" });
  };

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
    playerRef.current?.setVolume(volume);
    setAudioRunning(playerRef.current?.running ?? false);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {radio.error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" /> {radio.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Control rail — receiver controls, or ADS-B traffic when in map view */}
        <aside className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-r bg-sidebar">
          {view === "adsb" ? (
            <AdsbPanel
              aircraft={radio.aircraft}
              messageRate={radio.messageRate}
            />
          ) : (
            <>
              <Presets state={state} send={radio.send} />
              <Bookmarks state={state} send={radio.send} />
              <Controls
                state={state}
                deviceInfo={radio.deviceInfo}
                signal={radio.signal}
                send={radio.send}
                volume={volume}
                onVolume={(v) => {
                  setVolume(v);
                  playerRef.current?.setVolume(v);
                }}
                audioRunning={audioRunning}
                onEnableAudio={enableAudio}
              />
            </>
          )}
        </aside>

        {/* Main column: view tabs + spectrum/waterfall or live ADS-B map */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b px-4 py-2">
            <ViewTabs view={view} onChange={switchView} />
            {view === "adsb" && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {radio.aircraft.length} aircraft · {radio.messageRate} msg/s
              </span>
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
                  onTune={(hz) => radio.send({ type: "setVfoOffset", hz })}
                />
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1">
              <AdsbMap aircraft={radio.aircraft} />
            </div>
          )}
        </main>
      </div>

      <StatusBar state={state} audioRunning={audioRunning} view={view} />
    </div>
  );
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
    { id: "adsb", label: "ADS-B Map", icon: Plane },
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

function StatusBar({
  state,
  audioRunning,
  view,
}: {
  state: RadioState;
  audioRunning: boolean;
  view: View;
}) {
  return (
    <footer className="flex items-center justify-between gap-4 border-t bg-sidebar px-5 py-1.5 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Activity className="size-3 text-primary" />
        {view === "adsb"
          ? "Decoding Mode S extended squitter at 1090 MHz · markers update live"
          : "Click the spectrum to tune · scroll a digit to nudge · click it to type"}
      </span>
      <div className="flex items-center gap-4">
        {view === "adsb" ? (
          <Stat label="FREQ" value="1090.000M" />
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
