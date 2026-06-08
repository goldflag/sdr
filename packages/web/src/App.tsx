import { useEffect, useRef, useState } from "react";
import { DEFAULT_STATE, type RadioState } from "@sdr/shared";
import { useRadio } from "@/lib/ws";
import { PcmPlayer } from "@/audio/pcm-player";
import { SpectrumWaterfall } from "@/components/SpectrumWaterfall";
import { Controls } from "@/components/Controls";
import { Presets } from "@/components/Presets";
import { Bookmarks } from "@/components/Bookmarks";
import { Vfo } from "@/components/Vfo";
import { Activity, AlertTriangle } from "lucide-react";

export default function App() {
  const radio = useRadio();
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const [audioRunning, setAudioRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);

  const state = radio.state ?? DEFAULT_STATE;

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
        {/* Control rail */}
        <aside className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-r bg-sidebar">
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
        </aside>

        {/* Main column: tuning bar + spectrum/waterfall */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="border-b px-5 py-4">
            <Vfo state={state} send={radio.send} />
          </div>
          <div className="min-h-0 flex-1 p-4">
            <SpectrumWaterfall
              subscribeFft={radio.subscribeFft}
              state={state}
              onTune={(hz) => radio.send({ type: "setVfoOffset", hz })}
            />
          </div>
        </main>
      </div>

      <StatusBar state={state} audioRunning={audioRunning} />
    </div>
  );
}

function StatusBar({
  state,
  audioRunning,
}: {
  state: RadioState;
  audioRunning: boolean;
}) {
  return (
    <footer className="flex items-center justify-between gap-4 border-t bg-sidebar px-5 py-1.5 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Activity className="size-3 text-primary" />
        Click the spectrum to tune · scroll a digit to nudge · click it to type
      </span>
      <div className="flex items-center gap-4">
        <Stat label="MODE" value={state.mode} />
        <Stat label="BW" value={`${(state.bandwidth / 1000).toFixed(1)}k`} />
        <Stat label="SR" value={`${(state.sampleRate / 1e6).toFixed(3)}M`} />
        <Stat
          label="GAIN"
          value={
            state.gainMode === "auto" ? "AUTO" : `${state.gainDb.toFixed(0)}dB`
          }
        />
        <Stat label="AUDIO" value={audioRunning ? "ON" : "OFF"} />
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
