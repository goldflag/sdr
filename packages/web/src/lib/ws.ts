// React hook wrapping the radio WebSocket. Low-rate status (state, deviceInfo,
// signal) lives in React state; high-rate binary frames (FFT, audio) are
// delivered through imperative subscriptions so they don't trigger re-renders.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AudioFrame,
  type ClientMessage,
  type DeviceInfo,
  type FftFrame,
  type RadioState,
  type ServerMessage,
  BinaryFrameType,
  decodeAudioFrame,
  decodeFftFrame,
  frameType,
} from "@sdr/shared";

type FftCb = (f: FftFrame) => void;
type AudioCb = (f: AudioFrame) => void;

export interface SignalState {
  channelDb: number;
  squelchOpen: boolean;
}

export function useRadio() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RadioState | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [signal, setSignal] = useState<SignalState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const fftSubs = useRef(new Set<FftCb>());
  const audioSubs = useRef(new Set<AudioCb>());
  const sendQueue = useRef<ClientMessage[]>([]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        for (const m of sendQueue.current) ws.send(JSON.stringify(m));
        sendQueue.current = [];
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnectTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          handleJson(JSON.parse(ev.data) as ServerMessage);
          return;
        }
        const buf = ev.data as ArrayBuffer;
        switch (frameType(buf)) {
          case BinaryFrameType.FFT: {
            const f = decodeFftFrame(buf);
            for (const cb of fftSubs.current) cb(f);
            break;
          }
          case BinaryFrameType.AUDIO: {
            const f = decodeAudioFrame(buf);
            for (const cb of audioSubs.current) cb(f);
            break;
          }
        }
      };
    };

    const handleJson = (msg: ServerMessage) => {
      switch (msg.type) {
        case "state":
          setState(msg.state);
          break;
        case "deviceInfo":
          setDeviceInfo(msg.info);
          break;
        case "signal":
          setSignal({ channelDb: msg.channelDb, squelchOpen: msg.squelchOpen });
          break;
        case "error":
          setError(msg.message);
          break;
      }
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else sendQueue.current.push(msg);
  }, []);

  const subscribeFft = useCallback((cb: FftCb) => {
    fftSubs.current.add(cb);
    return () => {
      fftSubs.current.delete(cb);
    };
  }, []);

  const subscribeAudio = useCallback((cb: AudioCb) => {
    audioSubs.current.add(cb);
    return () => {
      audioSubs.current.delete(cb);
    };
  }, []);

  return {
    connected,
    state,
    deviceInfo,
    signal,
    error,
    send,
    subscribeFft,
    subscribeAudio,
  };
}
