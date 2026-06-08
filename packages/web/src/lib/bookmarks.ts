// User bookmarks (memory channels) persisted to localStorage.

import { useCallback, useEffect, useState } from "react";
import type { Tuning } from "./tuning";

export interface Bookmark extends Tuning {
  id: string;
  label: string;
}

const KEY = "sdr.bookmarks.v1";

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
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
