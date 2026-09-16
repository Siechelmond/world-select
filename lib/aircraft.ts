import type { SpatialEntity } from "@/lib/spatial";

const ADSB_BASE = "https://api.adsb.lol";

type AdsbAircraft = {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  squawk?: string;
  seen?: number;
  emergency?: string;
  category?: string;
};

type AdsbResponse = {
  ac?: AdsbAircraft[];
  now?: number;
  total?: number;
};

export type AircraftQuery = {
  latitude: number;
  longitude: number;
  radiusNm?: number;
};

export async function fetchAircraftNear(
  query: AircraftQuery,
  signal?: AbortSignal,
): Promise<SpatialEntity[]> {
  const radiusNm = Math.max(10, Math.min(250, Math.round(query.radiusNm ?? 180)));
  const lat = Number(query.latitude.toFixed(4));
  const lon = Number(query.longitude.toFixed(4));
  const url = `${ADSB_BASE}/v2/point/${lat}/${lon}/${radiusNm}`;
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`ADSB.lol returned HTTP ${response.status}`);

  const payload = (await response.json()) as AdsbResponse;
  const responseTime = typeof payload.now === "number" ? payload.now : Date.now();

  return (payload.ac ?? []).flatMap((aircraft, index) => {
    if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") return [];
    const baroFeet = typeof aircraft.alt_baro === "number" ? aircraft.alt_baro : null;
    const geomFeet = typeof aircraft.alt_geom === "number" ? aircraft.alt_geom : null;
    const altitudeFeet = geomFeet ?? baroFeet ?? 0;
    const altitudeMeters = altitudeFeet * 0.3048;
    const seenSeconds = typeof aircraft.seen === "number" ? aircraft.seen : 0;
    const hex = aircraft.hex?.trim() || `unknown-${index}`;
    const callsign = aircraft.flight?.trim() || aircraft.r?.trim() || hex.toUpperCase();

    return [{
      id: `adsblol:${hex}`,
      kind: "aircraft" as const,
      name: callsign,
      position: {
        longitude: aircraft.lon,
        latitude: aircraft.lat,
        altitudeMeters,
      },
      observedAt: new Date(responseTime - seenSeconds * 1000).toISOString(),
      dataState: "OBSERVED" as const,
      source: {
        id: "adsb-lol",
        label: "ADSB.lol community ADS-B",
        url: "https://www.adsb.lol/",
      },
      properties: {
        hex,
        registration: aircraft.r ?? null,
        aircraftType: aircraft.t ?? null,
        altitudeFt: Math.round(altitudeFeet),
        groundSpeedKt: typeof aircraft.gs === "number" ? Number(aircraft.gs.toFixed(1)) : null,
        trackDeg: typeof aircraft.track === "number" ? Number(aircraft.track.toFixed(1)) : null,
        squawk: aircraft.squawk ?? null,
        emergency: aircraft.emergency ?? "none",
        category: aircraft.category ?? null,
        seenSeconds: Number(seenSeconds.toFixed(1)),
        queryRadiusNm: radiusNm,
      },
    } satisfies SpatialEntity];
  });
}
