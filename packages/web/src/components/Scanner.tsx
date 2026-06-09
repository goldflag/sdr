// Scanner panel: step through bookmarks or sweep a band, stopping on activity.
// Drives the server-side scanner; live status comes back over the WebSocket.

import { useState } from "react";
import {
  type ClientMessage,
  type RadioState,
  type ScanStatus,
  SCAN_DEFAULTS,
} from "@sdr/shared";
import type { Bookmark } from "@/lib/bookmarks";
import { SCAN_RANGES } from "@/lib/scanRanges";
import { Section, Field, InfoTip } from "@/components/Controls";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatHz } from "@/lib/utils";
import { Radio, SkipForward, Square } from "lucide-react";

interface Props {
  state: RadioState;
  send: (msg: ClientMessage) => void;
  scan: ScanStatus | null;
  bookmarks: Bookmark[];
}

interface ScanSettings {
  thresholdDb: number;
  dwellMs: number;
  resumeMs: number;
}

const SETTINGS_KEY = "sdr.scan.settings";

function loadSettings(): ScanSettings {
  try {
    const v = localStorage.getItem(SETTINGS_KEY);
    if (v) return { ...SCAN_DEFAULTS, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
  return { ...SCAN_DEFAULTS };
}

export function Scanner({ state, send, scan, bookmarks }: Props) {
  const [tab, setTab] = useState<"channels" | "range">("channels");
  const [rangeIdx, setRangeIdx] = useState(0);
  const [cfg, setCfg] = useState<ScanSettings>(loadSettings);

  const update = (patch: Partial<ScanSettings>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const startBookmarks = () => {
    send({
      type: "scanStart",
      config: {
        kind: "channels",
        entries: bookmarks.map((b) => ({
          hz: b.hz,
          mode: b.mode,
          bandwidth: b.bandwidth,
          directSampling: b.directSampling,
          label: b.label,
        })),
        ...cfg,
      },
    });
  };

  const startRange = () => {
    const r = SCAN_RANGES[rangeIdx]!;
    send({
      type: "scanStart",
      config: {
        kind: "range",
        startHz: r.startHz,
        stopHz: r.stopHz,
        stepHz: r.stepHz,
        mode: r.mode,
        directSampling: r.directSampling,
        ...cfg,
      },
    });
  };

  return (
    <Section title="Scanner" aside={scan ? "scanning" : undefined}>
      {scan ? (
        <Active scan={scan} send={send} bookmarks={bookmarks} />
      ) : (
        <>
          <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
            {(["channels", "range"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors ${
                  tab === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "channels" ? "Bookmarks" : "Range"}
              </button>
            ))}
          </div>

          {tab === "channels" ? (
            <>
              <p className="text-[11px] text-muted-foreground">
                Step through your {bookmarks.length} bookmark
                {bookmarks.length === 1 ? "" : "s"} and stop when one becomes
                active.
              </p>
              <Button
                size="sm"
                className="w-full"
                disabled={bookmarks.length < 2}
                onClick={startBookmarks}
              >
                <Radio /> Scan bookmarks
              </Button>
            </>
          ) : (
            <>
              <Select
                value={String(rangeIdx)}
                onValueChange={(v) => setRangeIdx(Number(v))}
              >
                <SelectTrigger className="h-7 w-full px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCAN_RANGES.map((r, i) => (
                    <SelectItem key={r.name} value={String(i)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <RangeInfo idx={rangeIdx} />
              <Button size="sm" className="w-full" onClick={startRange}>
                <Radio /> Sweep range
              </Button>
            </>
          )}

          <Field
            label="Threshold"
            value={`${cfg.thresholdDb} dB`}
            info="Channel power above which a frequency counts as active and the scan stops. Lower = more sensitive (stops more often); raise it if it keeps stopping on noise."
          >
            <Slider
              value={[cfg.thresholdDb]}
              min={-90}
              max={0}
              step={1}
              onValueChange={([v]) => v != null && update({ thresholdDb: v })}
            />
          </Field>
          <Field
            label="Dwell"
            value={`${cfg.dwellMs} ms`}
            info="How long to listen on each silent channel before moving on."
          >
            <Slider
              value={[cfg.dwellMs]}
              min={100}
              max={1000}
              step={50}
              onValueChange={([v]) => v != null && update({ dwellMs: v })}
            />
          </Field>
          <Field
            label="Resume delay"
            value={`${(cfg.resumeMs / 1000).toFixed(1)} s`}
            info="After a signal ends, how long to keep listening before resuming the scan — so you don't miss the reply in a conversation."
          >
            <Slider
              value={[cfg.resumeMs]}
              min={500}
              max={6000}
              step={250}
              onValueChange={([v]) => v != null && update({ resumeMs: v })}
            />
          </Field>
        </>
      )}
    </Section>
  );
}

function RangeInfo({ idx }: { idx: number }) {
  const r = SCAN_RANGES[idx]!;
  const count = Math.floor((r.stopHz - r.startHz) / r.stepHz) + 1;
  return (
    <p className="font-mono text-[11px] text-muted-foreground">
      {(r.startHz / 1e6).toFixed(3)}–{(r.stopHz / 1e6).toFixed(3)} MHz · step{" "}
      {r.stepHz < 1000 ? `${r.stepHz} Hz` : `${r.stepHz / 1000} kHz`} · {r.mode} ·{" "}
      {count} ch
    </p>
  );
}

function Active({
  scan,
  send,
  bookmarks,
}: {
  scan: ScanStatus;
  send: (msg: ClientMessage) => void;
  bookmarks: Bookmark[];
}) {
  const label =
    scan.kind === "channels"
      ? bookmarks.find((b) => Math.abs(b.hz - scan.currentHz) < 1)?.label
      : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-2">
        <div className="flex flex-col">
          <span className="font-mono text-base tabular-nums text-foreground">
            {formatHz(scan.currentHz)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {label ? `${label} · ` : ""}
            {scan.mode} · {scan.index + 1}/{scan.total}
          </span>
        </div>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            scan.holding
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              scan.holding
                ? "bg-primary shadow-[0_0_6px_var(--primary)]"
                : "animate-pulse bg-muted-foreground/60"
            }`}
          />
          {scan.holding ? "holding" : "scanning"}
        </span>
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => send({ type: "scanSkip" })}
        >
          <SkipForward /> Skip
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="flex-1"
          onClick={() => send({ type: "scanStop" })}
        >
          <Square /> Stop
        </Button>
      </div>
    </div>
  );
}
