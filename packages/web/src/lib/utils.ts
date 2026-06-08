import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Formats a frequency in Hz as a human string (e.g. 100.300 MHz). */
export function formatHz(hz: number): string {
  if (Math.abs(hz) >= 1e9) return `${(hz / 1e9).toFixed(6)} GHz`
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`
  return `${hz} Hz`
}
