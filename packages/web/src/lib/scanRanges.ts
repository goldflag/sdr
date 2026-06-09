// Built-in range-scan presets: a band to sweep, the step between channels, and
// the mode to use. HF entries enable direct sampling (Q-branch).

import { DIRECT_SAMPLING, type DirectSampling, type Mode } from "@sdr/shared";

export interface ScanRange {
  name: string;
  startHz: number;
  stopHz: number;
  stepHz: number;
  mode: Mode;
  directSampling?: DirectSampling;
}

export const SCAN_RANGES: ScanRange[] = [
  { name: "Airband", startHz: 118_000_000, stopHz: 137_000_000, stepHz: 25_000, mode: "AM" },
  { name: "FM Broadcast", startHz: 88_000_000, stopHz: 108_000_000, stepHz: 100_000, mode: "WFM" },
  { name: "2m Ham", startHz: 144_000_000, stopHz: 148_000_000, stepHz: 12_500, mode: "NFM" },
  { name: "70cm Ham", startHz: 430_000_000, stopHz: 440_000_000, stepHz: 12_500, mode: "NFM" },
  { name: "Marine VHF", startHz: 156_000_000, stopHz: 162_025_000, stepHz: 25_000, mode: "NFM" },
  { name: "NOAA Weather", startHz: 162_400_000, stopHz: 162_550_000, stepHz: 25_000, mode: "NFM" },
  { name: "FRS / GMRS", startHz: 462_550_000, stopHz: 467_725_000, stepHz: 25_000, mode: "NFM" },
  {
    name: "40m Ham (SSB)",
    startHz: 7_060_000,
    stopHz: 7_200_000,
    stepHz: 1_000,
    mode: "LSB",
    directSampling: DIRECT_SAMPLING.Q_BRANCH,
  },
];
