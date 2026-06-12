// UI state for the app shell: which view is open, which map layers are
// enabled, the selected map target, the receiver location, and the spectrum
// display settings. Persisted fields keep their original localStorage keys so
// existing saved settings survive. Server-side effects of these changes
// (radio.send) stay with the callers — the store is pure state.

import { create } from "zustand";
import type { MapLayer } from "@sdr/shared";
import {
  DEFAULT_DISPLAY,
  type DisplaySettings,
} from "@/components/SpectrumDisplay";

export type View = "spectrum" | "track" | "ism";
export type Layers = Record<MapLayer, boolean>;

export interface ReceiverRef {
  lat: number;
  lon: number;
}

interface UiStore {
  view: View;
  layers: Layers;
  /** Selected map target id (ICAO / MMSI / callsign), shared by panels + map. */
  selected: string | null;
  receiverRef: ReceiverRef | null;
  display: DisplaySettings;
  /** Switch view; clears the map selection. */
  setView(view: View): void;
  setSelected(selected: string | null): void;
  /** Flip one layer, persist, and return the new layer set for server sync. */
  toggleLayer(layer: MapLayer): Layers;
  setReceiverRef(lat: number | null, lon: number | null): void;
  setDisplay(display: DisplaySettings): void;
}

// --- persistence (original keys preserved) ----------------------------------

const REF_KEY = "sdr.adsb.ref";

function loadRef(): ReceiverRef | null {
  try {
    const v = localStorage.getItem(REF_KEY);
    if (!v) return null;
    const r = JSON.parse(v);
    return typeof r?.lat === "number" && typeof r?.lon === "number" ? r : null;
  } catch {
    return null;
  }
}

function saveRef(r: ReceiverRef | null) {
  try {
    if (r) localStorage.setItem(REF_KEY, JSON.stringify(r));
    else localStorage.removeItem(REF_KEY);
  } catch {
    /* storage unavailable */
  }
}

const LAYERS_KEY = "sdr.map.layers";
const DEFAULT_LAYERS: Layers = { adsb: true, ais: false, aprs: false };

function loadLayers(): Layers {
  try {
    const v = localStorage.getItem(LAYERS_KEY);
    if (v) return { ...DEFAULT_LAYERS, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYERS;
}

function saveLayers(l: Layers) {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
}

const DISPLAY_KEY = "sdr.display";

function loadDisplay(): DisplaySettings {
  try {
    const v = localStorage.getItem(DISPLAY_KEY);
    if (v) return { ...DEFAULT_DISPLAY, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
  return DEFAULT_DISPLAY;
}

function saveDisplay(d: DisplaySettings) {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable */
  }
}

export const useUi = create<UiStore>((set, get) => ({
  view: "spectrum",
  layers: loadLayers(),
  selected: null,
  receiverRef: loadRef(),
  display: loadDisplay(),

  setView: (view) => set({ view, selected: null }),
  setSelected: (selected) => set({ selected }),
  toggleLayer: (layer) => {
    const layers = { ...get().layers, [layer]: !get().layers[layer] };
    saveLayers(layers);
    set({ layers });
    return layers;
  },
  setReceiverRef: (lat, lon) => {
    const receiverRef = lat != null && lon != null ? { lat, lon } : null;
    saveRef(receiverRef);
    set({ receiverRef });
  },
  setDisplay: (display) => {
    saveDisplay(display);
    set({ display });
  },
}));

