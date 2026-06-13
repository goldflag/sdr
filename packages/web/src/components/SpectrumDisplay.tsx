// Sidebar "Display" controls for the spectrum/waterfall: colormap selection and
// contrast (auto-scaling or fixed floor/ceiling dB). Zoom/pan live on the canvas
// itself (wheel + drag); these are the settings that benefit from real sliders.

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section, Field, InfoTip } from "@/components/Controls";
import {
  COLORMAP_NAMES,
  colormapGradient,
  type ColormapName,
} from "@/lib/colormaps";

export interface DisplaySettings {
  colormap: ColormapName;
  autoContrast: boolean;
  floorDb: number;
  ceilDb: number;
  /** Draw a second trace holding each bin's maximum since the last retune. */
  peakHold: boolean;
  /** Waterfall rows per second; below the FFT rate, frames are max-combined. */
  waterfallSpeed: number;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  colormap: "Aqua",
  autoContrast: true,
  floorDb: -90,
  ceilDb: -20,
  peakHold: false,
  waterfallSpeed: 20,
};

const WATERFALL_SPEEDS = [20, 10, 5, 2, 1];

interface Props {
  display: DisplaySettings;
  onChange: (next: DisplaySettings) => void;
  /** Server-side spectrum averaging strength (shared by all clients). */
  avg: number;
  onAvg: (level: number) => void;
}

export function SpectrumDisplay({ display, onChange, avg, onAvg }: Props) {
  const set = (patch: Partial<DisplaySettings>) =>
    onChange({ ...display, ...patch });

  return (
    <Section title="Display">
      <Field
        label="Colormap"
        info="Palette for the waterfall. Perceptual maps like Viridis or Inferno show subtle signal differences more evenly than the default."
      >
        <Select
          value={display.colormap}
          onValueChange={(v) => set({ colormap: v as ColormapName })}
        >
          <SelectTrigger className="h-7 w-full px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLORMAP_NAMES.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div
          className="mt-1 h-2 w-full rounded-sm"
          style={{ background: colormapGradient(display.colormap) }}
        />
      </Field>

      <Field
        label="Averaging"
        value={`${Math.round(avg * 100)}%`}
        info="Smooths the spectrum and waterfall over time. Higher settings pull weak steady signals out of the noise but blur short transmissions; turn it down when scanning for brief activity."
      >
        <Slider
          value={[avg]}
          min={0}
          max={1}
          step={0.05}
          onValueChange={([v]) => v != null && onAvg(v)}
        />
      </Field>

      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1 text-xs">
          Peak hold
          <InfoTip>
            A second trace holding the strongest level seen in each bin since
            the last retune — leave it running to catch intermittent
            transmissions and see which channels have been active.
          </InfoTip>
        </Label>
        <Switch
          size="sm"
          checked={display.peakHold}
          onCheckedChange={(on) => set({ peakHold: on })}
        />
      </div>

      <Field
        label="Waterfall speed"
        info="Rows per second. Slower speeds compress more time onto the screen — frames are combined by peak, so brief bursts still leave a mark."
      >
        <Select
          value={String(display.waterfallSpeed)}
          onValueChange={(v) => set({ waterfallSpeed: Number(v) })}
        >
          <SelectTrigger className="h-7 w-full px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WATERFALL_SPEEDS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} rows/s
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1 text-xs">
          Auto contrast
          <InfoTip>
            Continuously scales the display between the live noise floor and the
            strongest signal. Turn off to set fixed floor/ceiling levels — useful
            for comparing signal strengths or taming a noisy band.
          </InfoTip>
        </Label>
        <Switch
          size="sm"
          checked={display.autoContrast}
          onCheckedChange={(on) => set({ autoContrast: on })}
        />
      </div>

      {!display.autoContrast && (
        <>
          <Field label="Floor" value={`${display.floorDb} dB`}>
            <Slider
              value={[display.floorDb]}
              min={-120}
              max={0}
              step={1}
              onValueChange={([v]) =>
                v != null && set({ floorDb: Math.min(v, display.ceilDb - 5) })
              }
            />
          </Field>
          <Field label="Ceiling" value={`${display.ceilDb} dB`}>
            <Slider
              value={[display.ceilDb]}
              min={-120}
              max={0}
              step={1}
              onValueChange={([v]) =>
                v != null && set({ ceilDb: Math.max(v, display.floorDb + 5) })
              }
            />
          </Field>
        </>
      )}

      <p className="text-[11px] text-muted-foreground">
        Scroll over the spectrum to zoom (⇧-scroll pans); drag the waterfall to
        pan; double-click to reset.
      </p>
    </Section>
  );
}
