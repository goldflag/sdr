import type { ClientMessage, RadioState } from "@sdr/shared";
import { useBookmarks } from "@/lib/bookmarks";
import { applyTuning, tuningMatches } from "@/lib/tuning";
import { Section } from "@/components/Controls";
import { Button } from "@/components/ui/button";
import { formatHz } from "@/lib/utils";
import { Plus, Trash2 } from "lucide-react";

interface Props {
  state: RadioState;
  send: (msg: ClientMessage) => void;
}

export function Bookmarks({ state, send }: Props) {
  const { items, add, remove } = useBookmarks();
  const tuned = state.centerHz + state.vfoOffset;

  const addCurrent = () => {
    const fallback = `${(tuned / 1e6).toFixed(3)} ${state.mode}`;
    const label = window.prompt("Bookmark name", fallback);
    if (label === null) return; // cancelled
    add({
      label: label.trim() || fallback,
      hz: tuned,
      mode: state.mode,
      bandwidth: state.bandwidth,
      directSampling: state.directSampling,
    });
  };

  return (
    <Section
      title="Bookmarks"
      aside={items.length ? String(items.length) : undefined}
    >
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={addCurrent}
      >
        <Plus /> Save current
      </Button>

      {items.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {items.map((b) => {
            const active = tuningMatches(
              b,
              state.centerHz,
              state.vfoOffset,
              state.mode,
            );
            return (
              <li key={b.id} className="group flex items-center gap-1">
                <button
                  onClick={() => applyTuning(send, b)}
                  className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    active
                      ? "bg-primary/15 text-primary"
                      : "hover:bg-accent"
                  }`}
                >
                  <span className="truncate">{b.label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatHz(b.hz)} · {b.mode}
                  </span>
                </button>
                <button
                  onClick={() => remove(b.id)}
                  className="rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title="Delete bookmark"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
