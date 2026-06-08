import type { ClientMessage, RadioState } from "@sdr/shared";
import { BAND_PRESETS } from "@/lib/bands";
import { applyTuning, tuningMatches } from "@/lib/tuning";
import { Section } from "@/components/Controls";
import { Button } from "@/components/ui/button";

interface Props {
  state: RadioState;
  send: (msg: ClientMessage) => void;
}

export function Presets({ state, send }: Props) {
  return (
    <Section title="Bands">
      <div className="grid grid-cols-4 gap-1">
        {BAND_PRESETS.map((p) => {
          const active = tuningMatches(
            p,
            state.centerHz,
            state.vfoOffset,
            state.mode,
          );
          return (
            <Button
              key={p.name}
              variant={active ? "default" : "outline"}
              size="xs"
              onClick={() => applyTuning(send, p)}
            >
              {p.name}
            </Button>
          );
        })}
      </div>
    </Section>
  );
}
