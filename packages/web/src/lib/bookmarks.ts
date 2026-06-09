// User bookmarks (memory channels) persisted to localStorage.

import { useCallback, useEffect, useState } from "react";
import { DIRECT_SAMPLING } from "@sdr/shared";
import type { Tuning } from "./tuning";

export interface Bookmark extends Tuning {
  id: string;
  label: string;
}

const KEY = "sdr.bookmarks.v1";

// Seeded on first run so the list (and the scanner) isn't empty. HF entries set
// direct sampling (Q-branch), which the RTL-SDR V3 needs below ~24 MHz.
const DEFAULT_BOOKMARKS: Omit<Bookmark, "id">[] = [
  { label: "FM Radio", hz: 100_300_000, mode: "WFM" },
  { label: "Air Emergency", hz: 121_500_000, mode: "AM" },
  { label: "Airband", hz: 124_000_000, mode: "AM" },
  { label: "NOAA Weather", hz: 162_550_000, mode: "NFM" },
  { label: "Marine Ch16", hz: 156_800_000, mode: "NFM" },
  { label: "2m Calling", hz: 146_520_000, mode: "NFM" },
  { label: "70cm Calling", hz: 446_000_000, mode: "NFM" },
  { label: "FRS/GMRS 1", hz: 462_562_500, mode: "NFM" },
  { label: "WWV Time", hz: 10_000_000, mode: "AM", directSampling: DIRECT_SAMPLING.Q_BRANCH },
  { label: "40m SSB", hz: 7_100_000, mode: "LSB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
  { label: "20m SSB", hz: 14_200_000, mode: "USB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
  { label: "80m SSB", hz: 3_700_000, mode: "LSB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
];

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) {
      // First ever load: seed defaults (an empty "[]" means the user cleared
      // them, so we don't re-seed in that case).
      return DEFAULT_BOOKMARKS.map((b) => ({ ...b, id: newId() }));
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Bookmark[]) : [];
  } catch {
    return [];
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

export function useBookmarks() {
  const [items, setItems] = useState<Bookmark[]>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      // storage full / unavailable — ignore
    }
  }, [items]);

  const add = useCallback((b: Omit<Bookmark, "id">) => {
    setItems((prev) => [...prev, { ...b, id: newId() }]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const rename = useCallback((id: string, label: string) => {
    setItems((prev) => prev.map((b) => (b.id === id ? { ...b, label } : b)));
  }, []);

  return { items, add, remove, rename };
}
