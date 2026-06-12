// Live transcript panel for the spectrum sidebar. The server pipes the
// demodulated audio through a local whisper.cpp instance and pushes text
// segments as they complete; this panel toggles the feature, picks the model,
// shows the engine status and renders the rolling transcript. When the server
// lacks whisper-cpp or a model the toggle is disabled and a short install
// hint is shown instead.

import { useEffect, useRef } from "react";
import type {
  ClientMessage,
  TranscribeStatus,
  TranscriptSegment,
} from "@sdr/shared";
import { Captions } from "lucide-react";
import { Section } from "@/components/Controls";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  segments: TranscriptSegment[];
  on: boolean;
  available: boolean;
  /** Model in use (e.g. "small.en"), or null when unavailable. */
  model: string | null;
  /** All models found on the server, largest first. */
  models: string[];
  status: TranscribeStatus;
  send: (msg: ClientMessage) => void;
}

/** Keep the list pinned to the newest line unless the user scrolled up. */
const PIN_THRESHOLD_PX = 40;

const STATUS_ASIDE: Record<TranscribeStatus, string | undefined> = {
  off: undefined,
  loading: "○ loading",
  ready: "● live",
  lagging: "▲ lagging",
  failed: "✕ failed",
};

export function TranscriptPanel({
  segments,
  on,
  available,
  model,
  models,
  status,
  send,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  // Re-pin on every merge, not just on growth — live previews update in place.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  return (
    <Section
      title="Transcript · speech-to-text"
      aside={on ? STATUS_ASIDE[status] : undefined}
    >
      {!available ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Transcribes the tuned station with a local whisper.cpp — nothing
          leaves this machine. To enable, install it and download a model:{" "}
          <span className="font-mono">brew install whisper-cpp</span>, then put
          a <span className="font-mono">ggml-*.bin</span> model (e.g.{" "}
          <span className="font-mono">ggml-small.en.bin</span>) in{" "}
          <span className="font-mono">~/.cache/whisper.cpp</span> and restart
          the server.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              Transcribe the tuned audio
            </span>
            <Switch
              size="sm"
              checked={on}
              onCheckedChange={(v) => send({ type: "setTranscribe", on: v })}
            />
          </div>

          {models.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Model</span>
              <Select
                value={model ?? undefined}
                onValueChange={(m) =>
                  send({ type: "setTranscribeModel", model: m })
                }
              >
                <SelectTrigger className="h-6 w-auto min-w-0 gap-1 px-1.5 font-mono text-[10px] text-muted-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-xs">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {on && status === "loading" && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Captions className="size-3.5 animate-pulse" />
              Loading the {model ?? ""} model…
            </div>
          )}
          {on && status === "failed" && (
            <p className="text-[11px] leading-snug text-destructive">
              whisper-server failed to start — check the server logs, or try a
              different model.
            </p>
          )}
          {on && status === "lagging" && (
            <p className="text-[11px] leading-snug text-amber-500">
              Transcription can't keep up — oldest audio is being skipped. A
              smaller model will run faster.
            </p>
          )}
          {on && status === "ready" && segments.length === 0 && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Captions className="size-3.5 animate-pulse" />
              Listening — text appears a few seconds behind live.
            </div>
          )}

          {segments.length > 0 && (
            <div
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight <
                  PIN_THRESHOLD_PX;
              }}
              className="scroll-thin flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded bg-muted/30 px-2 py-1.5"
            >
              {segments.map((s, i) => (
                <div key={s.id} className="flex flex-col gap-0.5">
                  {(i === 0 || segments[i - 1]!.freqHz !== s.freqHz) && (
                    <span className="pt-0.5 font-mono text-[10px] text-primary/80">
                      {formatFreq(s.freqHz)}
                    </span>
                  )}
                  <div className="flex gap-2">
                    <span className="shrink-0 pt-px font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {formatTime(s.time)}
                    </span>
                    {/* Live previews refine in place until the utterance ends */}
                    <p
                      className={
                        s.final
                          ? "text-[11px] leading-snug text-foreground/90"
                          : "text-[11px] leading-snug italic text-muted-foreground"
                      }
                    >
                      {s.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour12: false });
}

function formatFreq(hz: number): string {
  if (hz >= 1e6) {
    return `${(hz / 1e6).toFixed(4).replace(/\.?0+$/, "")} MHz`;
  }
  return `${(hz / 1e3).toFixed(1).replace(/\.0$/, "")} kHz`;
}
