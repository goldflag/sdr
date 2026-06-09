// Optional online enrichment from adsbdb.com (no API key, CORS-open). The ADS-B
// signal itself carries no airframe type, operator, or route, so we look those
// up by ICAO address and callsign. Everything degrades silently: offline, a miss
// (404), or a network error just leaves the enriched fields empty and the decoded
// telemetry still shows. Each ICAO/callsign is fetched once and cached in memory
// + localStorage (airframe data is near-static), so the table stays cheap even
// with dozens of aircraft selected over a session.

import { useEffect, useState } from "react";

const BASE = "https://api.adsbdb.com/v0";
const TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

export interface AircraftDb {
  type?: string; // "G650 ER"
  icaoType?: string; // "G650"
  manufacturer?: string; // "Gulfstream Aerospace"
  registration?: string; // "N628TS"
  owner?: string; // "Falcon Landing LLC"
  countryName?: string; // "United States"
  countryIso?: string; // "US"
  photoThumb?: string;
}

export interface Airport {
  iata: string;
  icao: string;
  name: string;
  municipality: string;
}

export interface RouteDb {
  airline?: string;
  origin?: Airport;
  destination?: Airport;
}

// --- response shapes (only the fields we use) ------------------------------

interface AircraftJson {
  response?: {
    aircraft?: {
      type?: string;
      icao_type?: string;
      manufacturer?: string;
      registration?: string;
      registered_owner?: string;
      registered_owner_country_name?: string;
      registered_owner_country_iso_name?: string;
      url_photo_thumbnail?: string | null;
    };
  };
}

interface AirportJson {
  iata_code?: string;
  icao_code?: string;
  name?: string;
  municipality?: string;
}

interface RouteJson {
  response?: {
    flightroute?: {
      airline?: { name?: string } | null;
      origin?: AirportJson | null;
      destination?: AirportJson | null;
    };
  };
}

// --- cache -----------------------------------------------------------------

const mem = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

function readLs<T>(key: string): { v: T | null } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as { v: T | null; t: number };
    if (Date.now() - e.t > TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return { v: e.v };
  } catch {
    return null;
  }
}

function writeLs<T>(key: string, v: T | null) {
  try {
    localStorage.setItem(key, JSON.stringify({ v, t: Date.now() }));
  } catch {
    /* storage unavailable / quota; in-memory cache still applies */
  }
}

/**
 * Resolve `key` to a parsed value, hitting `url` only on a true cache miss.
 * A 404 (unknown airframe/route) is cached as a negative so we don't refetch it;
 * a network error resolves to null WITHOUT caching, so it can retry later.
 */
async function cached<T>(
  key: string,
  url: string,
  map: (json: unknown) => T | null,
): Promise<T | null> {
  if (mem.has(key)) return mem.get(key) as T | null;
  const ls = readLs<T>(key);
  if (ls) {
    mem.set(key, ls.v);
    return ls.v;
  }
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const p = (async () => {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        mem.set(key, null);
        writeLs<T>(key, null);
        return null;
      }
      if (!res.ok) return null; // transient server error: allow retry
      const val = map(await res.json());
      mem.set(key, val);
      writeLs(key, val);
      return val;
    } catch {
      return null; // offline / CORS / parse: don't poison the cache
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// --- lookups ---------------------------------------------------------------

export function lookupAircraft(icao: string): Promise<AircraftDb | null> {
  const id = icao.toUpperCase();
  return cached(`sdr.acdb.ac.${id}`, `${BASE}/aircraft/${id}`, (json) => {
    const a = (json as AircraftJson)?.response?.aircraft;
    if (!a) return null;
    return {
      type: a.type || undefined,
      icaoType: a.icao_type || undefined,
      manufacturer: a.manufacturer || undefined,
      registration: a.registration || undefined,
      owner: a.registered_owner || undefined,
      countryName: a.registered_owner_country_name || undefined,
      countryIso: a.registered_owner_country_iso_name || undefined,
      photoThumb: a.url_photo_thumbnail || undefined,
    };
  });
}

export function lookupRoute(callsign: string): Promise<RouteDb | null> {
  const cs = callsign.trim().toUpperCase();
  if (!cs) return Promise.resolve(null);
  const airport = (a?: AirportJson | null): Airport | undefined =>
    a
      ? {
          iata: a.iata_code || "",
          icao: a.icao_code || "",
          name: a.name || "",
          municipality: a.municipality || "",
        }
      : undefined;
  return cached(`sdr.acdb.rt.${cs}`, `${BASE}/callsign/${cs}`, (json) => {
    const r = (json as RouteJson)?.response?.flightroute;
    if (!r) return null;
    return {
      airline: r.airline?.name || undefined,
      origin: airport(r.origin),
      destination: airport(r.destination),
    };
  });
}

// --- hook ------------------------------------------------------------------

/**
 * Look up airframe details (by ICAO) and flight route (by callsign) for one
 * aircraft. `loading` tracks only the airframe request; the route fills in
 * quietly when it arrives.
 */
export function useAircraftDb(icao: string | null, callsign?: string | null) {
  const [aircraft, setAircraft] = useState<AircraftDb | null>(null);
  const [route, setRoute] = useState<RouteDb | null>(null);
  const [loading, setLoading] = useState(false);
  const cs = callsign?.trim() || "";

  useEffect(() => {
    if (!icao) {
      setAircraft(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    lookupAircraft(icao).then((a) => {
      if (!alive) return;
      setAircraft(a);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [icao]);

  useEffect(() => {
    if (!cs) {
      setRoute(null);
      return;
    }
    let alive = true;
    lookupRoute(cs).then((r) => alive && setRoute(r));
    return () => {
      alive = false;
    };
  }, [cs]);

  return { aircraft, route, loading };
}
