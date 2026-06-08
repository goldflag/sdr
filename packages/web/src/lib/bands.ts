// Built-in band presets for quick jumps. HF entries enable direct sampling
// (Q-branch) automatically, since the RTL-SDR V3 needs it below ~24 MHz.

import { DIRECT_SAMPLING } from "@sdr/shared";
import type { Tuning } from "./tuning";

export interface BandPreset extends Tuning {
  name: string;
}

export const BAND_PRESETS: BandPreset[] = [
  { name: "FM", hz: 100_300_000, mode: "WFM", directSampling: DIRECT_SAMPLING.OFF },
  { name: "Air", hz: 124_000_000, mode: "AM", directSampling: DIRECT_SAMPLING.OFF },
  { name: "NOAA", hz: 162_400_000, mode: "NFM", directSampling: DIRECT_SAMPLING.OFF },
  { name: "2m", hz: 145_000_000, mode: "NFM", directSampling: DIRECT_SAMPLING.OFF },
  { name: "70cm", hz: 433_000_000, mode: "NFM", directSampling: DIRECT_SAMPLING.OFF },
  { name: "80m", hz: 3_700_000, mode: "LSB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
  { name: "40m", hz: 7_100_000, mode: "LSB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
  { name: "20m", hz: 14_200_000, mode: "USB", directSampling: DIRECT_SAMPLING.Q_BRANCH },
];
