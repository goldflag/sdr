// React hook wrapping the radio WebSocket. Low-rate status (state, deviceInfo,
// signal) lives in React state; high-rate binary frames (FFT, audio) are
// delivered through imperative subscriptions so they don't trigger re-renders.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AircraftReport,
  type AudioFrame,
  type ClientMessage,
  type DeviceInfo,
  type FftFrame,
  type IsmEvent,
  type RadioState,
  type ScanStatus,
  type ServerMessage,
  type StationReport,
  type VesselReport,
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

export interface IsmStats {
  bursts: number;
  decoded: number;
  noiseDb: number;
  freqHz: number;
}

const ISM_LOG_MAX = 200;

/** Merge a fresh ISM event batch into the running log, keyed by stable id. */
function mergeIsm(prev: IsmEvent[], batch: IsmEvent[]): IsmEvent[] {
  if (batch.length === 0) return prev;
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of batch) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ISM_LOG_MAX);
}

export function useRadio() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RadioState | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [signal, setSignal] = useState<SignalState | null>(null);
  const [aircraft, setAircraft] = useState<AircraftReport[]>([]);
  const [messageRate, setMessageRate] = useState(0);
  const [vessels, setVessels] = useState<VesselReport[]>([]);
  const [aisMessageRate, setAisMessageRate] = useState(0);
  const [aisFramesSeen, setAisFramesSeen] = useState(0);
  const [stations, setStations] = useState<StationReport[]>([]);
  const [aprsMessageRate, setAprsMessageRate] = useState(0);
  const [aprsFramesSeen, setAprsFramesSeen] = useState(0);
  const [ismEvents, setIsmEvents] = useState<IsmEvent[]>([]);
  const [ismStats, setIsmStats] = useState<IsmStats | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
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
          setError(null); // a successful (re)connect clears any stale error
          break;
        case "signal":
          setSignal({ channelDb: msg.channelDb, squelchOpen: msg.squelchOpen });
          break;
        case "adsb":
          setAircraft(msg.aircraft);
          setMessageRate(msg.messageRate);
          break;
        case "ais":
          setVessels(msg.vessels);
          setAisMessageRate(msg.messageRate);
          setAisFramesSeen(msg.framesSeen);
          break;
        case "aprs":
          setStations(msg.stations);
          setAprsMessageRate(msg.messageRate);
          setAprsFramesSeen(msg.framesSeen);
          break;
        case "ism":
          setIsmStats({
            bursts: msg.bursts,
            decoded: msg.decoded,
            noiseDb: msg.noiseDb,
            freqHz: msg.freqHz,
          });
          setIsmEvents((prev) => mergeIsm(prev, msg.events));
          break;
        case "scan":
          setScan(msg.status);
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
    aircraft,
    messageRate,
    vessels,
    aisMessageRate,
    aisFramesSeen,
    stations,
    aprsMessageRate,
    aprsFramesSeen,
    ismEvents,
    ismStats,
    scan,
    error,
    send,
    subscribeFft,
    subscribeAudio,
  };
}
