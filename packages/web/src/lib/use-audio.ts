// Demodulated-audio playback: owns the PcmPlayer, pipes audio frames from the
// radio socket into it, and exposes the volume/mute controls for the toolbar.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioFrame } from "@sdr/shared";
import { PcmPlayer } from "@/audio/pcm-player";

export function useAudioPlayer(
  subscribeAudio: (cb: (f: AudioFrame) => void) => () => void,
) {
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const [running, setRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);

  // Pipe audio frames to the player.
  useEffect(
    () => subscribeAudio((f) => playerRef.current?.push(f.pcm)),
    [subscribeAudio],
  );

  // Browsers require a user gesture before audio can start.
  const enable = useCallback(async () => {
    await playerRef.current?.init();
    playerRef.current?.setVolume(muted ? 0 : volume);
    setRunning(playerRef.current?.running ?? false);
  }, [muted, volume]);

  // Dragging the slider sets a level and always unmutes.
  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    setMuted(false);
    playerRef.current?.setVolume(v);
  }, []);

  // Toggle mute, keeping the slider level so it can be restored.
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      playerRef.current?.setVolume(next ? 0 : volume);
      return next;
    });
  }, [volume]);

  /** Drop buffered audio (e.g. after a retune) to keep latency low. */
  const flush = useCallback(() => {
    playerRef.current?.flush();
  }, []);

  return { running, volume, muted, enable, changeVolume, toggleMute, flush };
}
