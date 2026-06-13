// Global keyboard tuning for the spectrum view. Bound to the window so the keys
// work without clicking into the canvas first, but it stays out of the way:
//   • Skipped while typing in a field (input/textarea/select/contenteditable).
//   • Skipped when another control already handled the key — sliders, selects
//     and the VFO digit editor all call preventDefault on the arrows, so we
//     defer to them via e.defaultPrevented rather than double-acting.
//
// Bindings:
//   ←/→        nudge the whole monitored band a fiftieth of a span down/up
//              (center frequency moves with it — the band and VFO slide together)
//   ⇧ + ←/→    move it a tenth of a span (a bigger hop)
//   ↑/↓        fine-tune the VFO a half-channel down/up within the band
//   ⇧ + ↑/↓    a larger step
//
// ←/→ retune the dongle, which needs a few ms to settle. Key auto-repeat fires
// ~30×/s, so we coalesce held repeats and retune at RETUNE_INTERVAL_MS instead —
// otherwise the tuner never settles and the band looks stuck while the displayed
// frequency races ahead. The target center is accumulated locally so holding a
// key keeps panning smoothly without waiting for each server round-trip.

import { useEffect, useRef } from "react";
import type { ClientMessage, RadioState } from "@sdr/shared";
import { nudgeTuned, pannedCenter } from "@/lib/tuning";

const RETUNE_INTERVAL_MS = 90; // ≤ ~11 retunes/s — a rate the tuner keeps up with
const IDLE_RESYNC_MS = 300; // after this quiet, trust the server's center again

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
  // Pending dongle center, accumulated across held keys; null when idle.
  const targetHz = useRef<number | null>(null);
  const lastKey = useRef(0);
  const lastSent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const flush = () => {
      timer.current = null;
      if (targetHz.current == null) return;
      ref.current.send({ type: "setFrequency", hz: targetHz.current });
      lastSent.current = Date.now();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const { state, send } = ref.current;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const now = Date.now();
          // Build on the live target mid-gesture; after a pause, re-seed from the
          // server's current center so we never drift from where the radio is.
          const base =
            targetHz.current != null && now - lastKey.current < IDLE_RESYNC_MS
              ? targetHz.current
              : state.centerHz;
          lastKey.current = now;
          targetHz.current = pannedCenter(
            base,
            state.sampleRate,
            e.key === "ArrowRight" ? 1 : -1,
            e.shiftKey ? 0.1 : 0.02,
          );
          // Leading + throttled-trailing: first press fires immediately, held
          // repeats coalesce into one retune per RETUNE_INTERVAL_MS.
          if (timer.current == null) {
            timer.current = setTimeout(
              flush,
              Math.max(0, RETUNE_INTERVAL_MS - (now - lastSent.current)),
            );
          }
          break;
        }
        case "ArrowUp":
        case "ArrowDown": {
          // VFO offset only shifts the NCO (no hardware settling), so this can
          // fire per key without the retune throttle ←/→ needs.
          e.preventDefault();
          const fine = Math.max(500, Math.round(state.bandwidth / 2));
          const step = e.shiftKey ? fine * 10 : fine;
          nudgeTuned(send, state, e.key === "ArrowUp" ? 1 : -1, step);
          break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = null;
      targetHz.current = null;
    };
  }, [enabled]);
}
