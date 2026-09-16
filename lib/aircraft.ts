import type { SpatialEntity } from "@/lib/spatial";

type AdsbAircraft = {
  hex?: string; flight?: string; r?: string | null; t?: string | null; lat?: number; lon?: number;
  alt_baro?: number | "ground" | null; alt_geom?: number | null; gs?: number | null; track?: number | null;
  squawk?: string | null; seen?: number; emergency?: string; category?: string;
};

type AdsbResponse = { ac?: AdsbAircraft[]; now?: number; total?: number; provider?: string };
export type AircraftQuery = { latitude: number; longitude: number; radiusNm?: number };

function providerSource(provider?: string) {
  switch (provider) {
    case "airplanes.live": return { id: "airplanes-live", label: "airplanes.live ADS-B", url: "https://airplanes.live/" };
    case "adsb.fi": return { id: "adsb-fi", label: "adsb.fi open data", url: "https://adsb.fi/" };
    case "opensky": return { id: "opensky", label: "OpenSky Network", url: "https://opensky-network.org/" };
    default: return { id: "adsb-lol", label: "ADSB.lol community ADS-B", url: "https://www.adsb.lol/" };
  }
}

export async function fetchAircraftNear(query: AircraftQuery, signal?: AbortSignal): Promise<SpatialEntity[]> {
  const radiusNm = Math.max(25, Math.min(250, Math.round(query.radiusNm ?? 220)));
  const lat = Number(query.latitude.toFixed(4));
  const lon = Number(query.longitude.toFixed(4));
  const response = await fetch(`/api/aircraft?lat=${lat}&lon=${lon}&radius=${radiusNm}`, { signal, cache: "no-store" });
  if (!response.ok) {
    let detail = "";
    try { detail = JSON.stringify(await response.json()); } catch { /* ignore */ }
    throw new Error(`Aircraft proxy returned HTTP ${response.status}${detail ? ` · ${detail.slice(0, 180)}` : ""}`);
  }
  const payload = (await response.json()) as AdsbResponse;
  const responseTimeMs = typeof payload.now === "number"
    ? (payload.now < 10_000_000_000 ? payload.now * 1000 : payload.now)
    : Date.now();

  return (payload.ac ?? []).flatMap((aircraft, index) => {
    if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") return [];
    const baroFeet = typeof aircraft.alt_baro === "number" ? aircraft.alt_baro : null;
    const geomFeet = typeof aircraft.alt_geom === "number" ? aircraft.alt_geom : null;
    const altitudeFeet = geomFeet ?? baroFeet ?? 0;
    const altitudeMeters = Math.max(0, altitudeFeet * 0.3048);
    const seenSeconds = typeof aircraft.seen === "number" ? aircraft.seen : 0;
    const hex = aircraft.hex?.trim() || `unknown-${index}`;
    const callsign = aircraft.flight?.trim() || aircraft.r?.trim() || hex.toUpperCase();
    return [{
      id: `aircraft:${hex}`,
      kind: "aircraft" as const,
      name: callsign,
      position: { longitude: aircraft.lon, latitude: aircraft.lat, altitudeMeters },
      observedAt: new Date(responseTimeMs - seenSeconds * 1000).toISOString(),
      dataState: "OBSERVED" as const,
      source: providerSource(payload.provider),
      properties: {
        provider: payload.provider ?? "unknown",
        hex, registration: aircraft.r ?? null, aircraftType: aircraft.t ?? null,
        altitudeFt: Math.round(altitudeFeet),
        groundSpeedKt: typeof aircraft.gs === "number" ? Number(aircraft.gs.toFixed(1)) : null,
        trackDeg: typeof aircraft.track === "number" ? Number(aircraft.track.toFixed(1)) : null,
        squawk: aircraft.squawk ?? null, emergency: aircraft.emergency ?? "none",
        category: aircraft.category ?? null, seenSeconds: Number(seenSeconds.toFixed(1)), queryRadiusNm: radiusNm,
        renderModel: "dead-reckoning between observed ADS-B updates",
      },
    } satisfies SpatialEntity];
  });
}

// Display-only interpolation between actual ADS-B updates. The stored entity remains OBSERVED.
export function projectAircraftPosition(entity: SpatialEntity, atMs: number) {
  if (entity.kind !== "aircraft") return entity.position;
  const speedKt = Number(entity.properties.groundSpeedKt ?? 0);
  const trackDeg = Number(entity.properties.trackDeg ?? NaN);
  const observedMs = Date.parse(entity.observedAt);
  if (!Number.isFinite(speedKt) || speedKt <= 0 || !Number.isFinite(trackDeg) || !Number.isFinite(observedMs)) return entity.position;
  const seconds = Math.max(0, Math.min(25, (atMs - observedMs) / 1000));
  const distanceKm = speedKt * 1.852 * seconds / 3600;
  const angular = distanceKm / 6371.0088;
  const bearing = trackDeg * Math.PI / 180;
  const lat1 = entity.position.latitude * Math.PI / 180;
  const lon1 = entity.position.longitude * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return {
    latitude: lat2 * 180 / Math.PI,
    longitude: ((lon2 * 180 / Math.PI + 540) % 360) - 180,
    altitudeMeters: entity.position.altitudeMeters,
  };
}
