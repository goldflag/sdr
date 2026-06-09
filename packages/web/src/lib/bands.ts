// Built-in band presets for quick jumps. HF entries enable direct sampling
// (Q-branch) automatically, since the RTL-SDR V3 needs it below ~24 MHz.

import { DIRECT_SAMPLING } from "@sdr/shared";
import type { Tuning } from "./tuning";

export interface BandPreset extends Tuning {
  name: string;
  description: string;
}

export const BAND_PRESETS: BandPreset[] = [
  {
    name: "FM",
    hz: 100_300_000,
    mode: "WFM",
    directSampling: DIRECT_SAMPLING.OFF,
    description:
      "Commercial FM broadcast radio (88–108 MHz). Wideband FM music and talk stations.",
  },
  {
    name: "Air",
    hz: 124_000_000,
    mode: "AM",
    directSampling: DIRECT_SAMPLING.OFF,
    description:
      "Aircraft band (118–137 MHz). AM voice between pilots and air traffic control.",
  },
  {
    name: "NOAA",
    hz: 162_400_000,
    mode: "NFM",
    directSampling: DIRECT_SAMPLING.OFF,
    description:
      "NOAA weather radio (162.4–162.55 MHz). Continuous narrowband FM forecasts and alerts.",
  },
  {
    name: "2m",
    hz: 145_000_000,
    mode: "NFM",
    directSampling: DIRECT_SAMPLING.OFF,
    description:
      "2-meter amateur band (144–148 MHz VHF). Ham voice repeaters and simplex on narrowband FM.",
  },
  {
    name: "70cm",
    hz: 433_000_000,
    mode: "NFM",
    directSampling: DIRECT_SAMPLING.OFF,
    description:
      "70-centimeter amateur band (420–450 MHz UHF). Ham repeaters and digital modes; also shares ISM 433 MHz.",
  },
  {
    name: "80m",
    hz: 3_700_000,
    mode: "LSB",
    directSampling: DIRECT_SAMPLING.Q_BRANCH,
    description:
      "80-meter amateur HF band (3.5–4 MHz). Regional nighttime SSB voice on lower sideband. Uses direct sampling.",
  },
  {
    name: "40m",
    hz: 7_100_000,
    mode: "LSB",
    directSampling: DIRECT_SAMPLING.Q_BRANCH,
    description:
      "40-meter amateur HF band (7.0–7.3 MHz). Reliable day/night SSB on lower sideband. Uses direct sampling.",
  },
  {
    name: "20m",
    hz: 14_200_000,
    mode: "USB",
    directSampling: DIRECT_SAMPLING.Q_BRANCH,
    description:
      "20-meter amateur HF band (14.0–14.35 MHz). Workhorse daytime DX on upper sideband. Uses direct sampling.",
  },
];
