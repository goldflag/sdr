// Compact "Export" control for the decoder panels: a small button that opens a
// CSV / JSON menu and downloads the current log. Self-contained (no dropdown
// primitive in the UI kit) — dismisses on outside-click or Escape.

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  type Column,
  downloadText,
  fileStamp,
  toCsv,
} from "@/lib/export";

interface Props<T> {
  /** Filename stem; a timestamp + extension are appended (e.g. "adsb"). */
  baseName: string;
  rows: readonly T[];
  columns: Column<T>[];
  /** Value serialized for the JSON export; defaults to `rows`. */
  json?: unknown;
}

export function ExportButton<T>({ baseName, rows, columns, json }: Props<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const empty = rows.length === 0;

  const exportCsv = () => {
    downloadText(
      `${baseName}_${fileStamp()}.csv`,
      "text/csv;charset=utf-8",
      toCsv(rows, columns),
    );
    setOpen(false);
  };
  const exportJson = () => {
    downloadText(
      `${baseName}_${fileStamp()}.json`,
      "application/json",
      JSON.stringify(json ?? rows, null, 2),
    );
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={empty}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={empty ? "Nothing to export yet" : "Export decoded log"}
        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none"
      >
        <Download className="size-3" /> Export
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 flex min-w-[8rem] flex-col rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <MenuItem onClick={exportCsv} label="CSV" count={rows.length} />
          <MenuItem onClick={exportJson} label="JSON" count={rows.length} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  count,
}: {
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex items-center justify-between gap-3 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
    >
      <span>{label}</span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}
