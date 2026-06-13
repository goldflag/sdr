// Global keyboard tuning for the spectrum view. Bound to the window so the keys
// work without clicking into the canvas first, but it stays out of the way:
//   • Skipped while typing in a field (input/textarea/select/contenteditable).
//   • Skipped when another control already handled the key — sliders, selects
//     and the VFO digit editor all call preventDefault on the arrows, so we
//     defer to them via e.defaultPrevented rather than double-acting.
//
// Bindings:
//   ←/→        nudge the whole monitored band a tenth of a span down/up (center
//              frequency moves with it — the band and VFO slide together)
//   ⇧ + ←/→    move it half a span (a bigger hop)
//   ↑/↓        fine-tune the VFO a half-channel down/up within the band
//   ⇧ + ↑/↓    a larger step

import { useEffect, useRef } from "react";
import type { ClientMessage, RadioState } from "@sdr/shared";
import { panBand, nudgeTuned } from "@/lib/tuning";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

interface Options {
  state: RadioState;
  send: (msg: ClientMessage) => void;
  /** Only active in the spectrum view; the map/ISM views ignore these keys. */
  enabled: boolean;
}

export function useRadioKeys({ state, send, enabled }: Options) {
  // The listener is bound once per enable; a ref keeps it reading live state.
  const ref = useRef({ state, send });
  ref.current = { state, send };

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const { state, send } = ref.current;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight":
          e.preventDefault();
          panBand(
            send,
            state,
            e.key === "ArrowRight" ? 1 : -1,
            e.shiftKey ? 0.5 : 0.1,
          );
          break;
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const fine = Math.max(500, Math.round(state.bandwidth / 2));
          const step = e.shiftKey ? fine * 10 : fine;
          nudgeTuned(send, state, e.key === "ArrowUp" ? 1 : -1, step);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
