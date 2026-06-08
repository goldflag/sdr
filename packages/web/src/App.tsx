import { useEffect, useRef, useState } from "react";
import { DEFAULT_STATE } from "@sdr/shared";
import { useRadio } from "@/lib/ws";
import { PcmPlayer } from "@/audio/pcm-player";
import { SpectrumWaterfall } from "@/components/SpectrumWaterfall";
import { Controls } from "@/components/Controls";
import { Vfo } from "@/components/Vfo";
import { Card, CardContent } from "@/components/ui/card";
import { Wifi, WifiOff, AlertTriangle } from "lucide-react";

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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header connected={radio.connected} device={radio.deviceInfo?.tunerName} />

      {radio.error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5" /> {radio.error}
        </div>
      )}

      <div className="grid flex-1 grid-cols-[1fr_340px] gap-3 overflow-hidden p-3">
        {/* Main column: VFO + spectrum/waterfall */}
        <div className="flex min-w-0 flex-col gap-3">
          <Card>
            <CardContent className="p-4">
              <Vfo
                state={state}
                onSetCenter={(hz) => radio.send({ type: "setFrequency", hz })}
                onSetOffset={(hz) => radio.send({ type: "setVfoOffset", hz })}
              />
            </CardContent>
          </Card>
          <div className="min-h-0 flex-1">
            <SpectrumWaterfall
              subscribeFft={radio.subscribeFft}
              state={state}
              onTune={(hz) => radio.send({ type: "setVfoOffset", hz })}
            />
          </div>
        </div>

        {/* Sidebar: controls */}
        <div className="overflow-y-auto pr-1">
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
        </div>
      </div>
    </div>
  );
}

function Header({
  connected,
  device,
}: {
  connected: boolean;
  device?: string;
}) {
  return (
    <header className="flex items-center justify-between border-b px-4 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight">SDR</span>
        <span className="text-xs text-muted-foreground">RTL-SDR Blog V3</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {device && <span className="text-muted-foreground">{device}</span>}
        <span
          className={`flex items-center gap-1.5 ${connected ? "text-primary" : "text-muted-foreground"}`}
        >
          {connected ? (
            <Wifi className="size-3.5" />
          ) : (
            <WifiOff className="size-3.5" />
          )}
          {connected ? "connected" : "offline"}
        </span>
      </div>
    </header>
  );
}
