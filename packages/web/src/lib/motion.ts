// Smooth marker motion (dead reckoning).
//
// ADS-B position fixes land every few seconds, so markers would otherwise jump.
// Between fixes we extrapolate each aircraft forward from its last reported
// position along its heading at its ground speed, every animation frame. When a
// fresh fix arrives we don't snap to it: we record the small offset between
// where the marker is and where the new fix predicts, then bleed that offset off
// over MOTION_CORRECT_MS so the path stays continuous.

import { fromLonLat } from "ol/proj";

export const MOTION_CORRECT_MS = 700; // ease a position correction over this window
export const MAX_EXTRAPOLATE_S = 8; // cap dead reckoning so a stalled feed can't fling markers
const KNOTS_TO_MS = 0.514444;

export interface MotionState {
  lat: number;
  lon: number;
  speed: number; // knots; 0 = stationary/unknown -> no extrapolation
  heading: number; // degrees
  epoch: number; // client ms the reported position was valid
  corr: [number, number]; // residual mercator offset, bled off after a correction
  corrEpoch: number; // client ms the correction was applied
}

// Move a lat/lon forward by distM metres along a compass bearing (great-circle).
function projectLatLon(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): [number, number] {
  const R = 6378137;
  const d = distM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

export function predictLonLat(m: MotionState, now: number): [number, number] {
  if (m.speed <= 0.5) return [m.lon, m.lat];
  const elapsed = Math.min((now - m.epoch) / 1000, MAX_EXTRAPOLATE_S);
  if (elapsed <= 0) return [m.lon, m.lat];
  return projectLatLon(m.lat, m.lon, m.heading, m.speed * KNOTS_TO_MS * elapsed);
}

// Rendered mercator coordinate: extrapolated position + the decaying correction.
export function motionCoord(m: MotionState, now: number): number[] {
  const [lon, lat] = predictLonLat(m, now);
  const merc = fromLonLat([lon, lat]);
  const k = Math.max(0, 1 - (now - m.corrEpoch) / MOTION_CORRECT_MS);
  return [merc[0]! + m.corr[0] * k, merc[1]! + m.corr[1] * k];
}
