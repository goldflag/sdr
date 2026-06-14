// Demodulated-audio playback: owns the PcmPlayer, pipes audio frames from the
// radio socket into it, and exposes the volume/mute controls for the toolbar.
// The same frame stream is tapped by a WavRecorder so the audio can be recorded
// to a downloadable WAV — independently of whether playback is enabled.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioFrame } from "@sdr/shared";
import { PcmPlayer } from "@/audio/pcm-player";
import { WavRecorder } from "@/audio/wav-recorder";
import { downloadBlob, fileStamp } from "@/lib/export";

/** Frequency + mode captured when a recording starts, for the filename. */
export interface RecordingMeta {
  freqHz: number;
  mode: string;
}

export function useAudioPlayer(
  subscribeAudio: (cb: (f: AudioFrame) => void) => () => void,
) {
  const playerRef = useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new PcmPlayer();
  const recorderRef = useRef<WavRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new WavRecorder();
  const metaRef = useRef<RecordingMeta | null>(null);

  const [running, setRunning] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  // Pipe audio frames to the player and (when armed) the recorder.
  useEffect(
    () =>
      subscribeAudio((f) => {
        playerRef.current?.push(f.pcm);
        recorderRef.current?.push(f.pcm, f.sampleRate);
      }),
    [subscribeAudio],
  );

  // While recording, tick the elapsed/size readout once a second.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      setRecSeconds(recorderRef.current?.durationSec ?? 0);
    }, 1000);
    return () => clearInterval(id);
  }, [recording]);

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

  /** Begin capturing the audio stream. `meta` labels the eventual filename. */
  const startRecording = useCallback((meta: RecordingMeta) => {
    metaRef.current = meta;
    recorderRef.current?.start();
    setRecSeconds(0);
    setRecording(true);
  }, []);

  /** Stop and download the WAV. No-op if nothing was captured. */
  const stopRecording = useCallback(() => {
    const blob = recorderRef.current?.stop() ?? null;
    setRecording(false);
    setRecSeconds(0);
    if (!blob) return;
    const m = metaRef.current;
    const tag = m ? `${(m.freqHz / 1e6).toFixed(4)}MHz_${m.mode}_` : "";
    downloadBlob(`sdr_${tag}${fileStamp()}.wav`, blob);
  }, []);

  return {
    running,
    volume,
    muted,
    recording,
    recSeconds,
    enable,
    changeVolume,
    toggleMute,
    flush,
    startRecording,
    stopRecording,
  };
}
