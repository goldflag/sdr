import type { ClientMessage, RadioState } from "@sdr/shared";
import { BAND_PRESETS } from "@/lib/bands";
import { applyTuning, tuningMatches } from "@/lib/tuning";
import { Section } from "@/components/Controls";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
            <Tooltip key={p.name}>
              <TooltipTrigger asChild>
                <Button
                  variant={active ? "default" : "outline"}
                  size="xs"
                  onClick={() => applyTuning(send, p)}
                >
                  {p.name}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{p.description}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </Section>
  );
}
