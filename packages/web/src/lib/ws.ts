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
  type RdsStation,
  type RdsStats,
  type ScanStatus,
  type ServerMessage,
  type StationReport,
  type TranscriptSegment,
  type VesselReport,
  BinaryFrameType,
  PROTOCOL_VERSION,
  decodeAudioFrame,
  decodeFftFrame,
  frameType,
} from "@sdr/shared";

type FftCb = (f: FftFrame) => void;
type AudioCb = (f: AudioFrame) => void;

// Reconnect with exponential backoff + jitter so a down/restarting server gets
// a handful of quick retries, not a steady 1 Hz hammering from every open tab.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_JITTER_MS = 300;

// Messages queued while disconnected are flushed on reconnect; cap the queue so
// a long outage doesn't replay hundreds of stale control changes.
const SEND_QUEUE_MAX = 64;

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
const TRANSCRIPT_LOG_MAX = 200;

/** Merge a fresh ISM event batch into the running log, keyed by stable id. */
function mergeIsm(prev: IsmEvent[], batch: IsmEvent[]): IsmEvent[] {
  if (batch.length === 0) return prev;
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of batch) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ISM_LOG_MAX);
}

/** Merge transcript segments by id, oldest first (the panel reads downward).
 *  Live previews re-arrive under the same id with longer text; an empty-text
 *  final is a tombstone (the preview turned out to be nothing) — remove it. */
function mergeTranscripts(
  prev: TranscriptSegment[],
  batch: TranscriptSegment[],
): TranscriptSegment[] {
  if (batch.length === 0) return prev;
  const byId = new Map(prev.map((s) => [s.id, s]));
  for (const s of batch) {
    if (s.final && s.text === "") byId.delete(s.id);
    else byId.set(s.id, s);
  }
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .slice(-TRANSCRIPT_LOG_MAX);
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
  const [rdsStation, setRdsStation] = useState<RdsStation | null>(null);
  const [rdsStats, setRdsStats] = useState<RdsStats | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const fftSubs = useRef(new Set<FftCb>());
  const audioSubs = useRef(new Set<AudioCb>());
  const sendQueue = useRef<ClientMessage[]>([]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    // Set on a version-mismatched hello; keeps the "reload the page" error from
    // being cleared by the deviceInfo/state sync that follows it.
    let protocolMismatch = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        setError(null);
        for (const m of sendQueue.current) ws.send(JSON.stringify(m));
        sendQueue.current = [];
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay =
          Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts) +
          Math.random() * RECONNECT_JITTER_MS;
        attempts++;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let msg: ServerMessage;
          try {
            msg = JSON.parse(ev.data) as ServerMessage;
          } catch {
            console.warn("[ws] dropping non-JSON server message");
            return;
          }
          handleJson(msg);
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
          default:
            // A frame type this build doesn't know — likely a protocol bump.
            console.warn(`[ws] unknown binary frame type ${frameType(buf)}`);
        }
      };
    };

    const handleJson = (msg: ServerMessage) => {
      switch (msg.type) {
        case "hello":
          protocolMismatch = msg.protocol !== PROTOCOL_VERSION;
          if (protocolMismatch) {
            setError(
              `protocol mismatch (server v${msg.protocol}, this page v${PROTOCOL_VERSION}) — reload the page`,
            );
          }
          break;
        case "state":
          setState(msg.state);
          break;
        case "deviceInfo":
          setDeviceInfo(msg.info);
          // A successful (re)connect clears any stale error — but never the
          // protocol-mismatch warning, which only a reload fixes.
          if (!protocolMismatch) setError(null);
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
        case "rds":
          setRdsStation(msg.station);
          setRdsStats(msg.stats);
          break;
        case "transcript":
          setTranscripts((prev) => mergeTranscripts(prev, msg.segments));
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
    else {
      sendQueue.current.push(msg);
      if (sendQueue.current.length > SEND_QUEUE_MAX) sendQueue.current.shift();
    }
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
    rdsStation,
    rdsStats,
    transcripts,
    scan,
    error,
    send,
    subscribeFft,
    subscribeAudio,
  };
}
