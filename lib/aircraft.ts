import type { SpatialEntity } from "@/lib/spatial";

type AdsbAircraft = {
  hex?: string;
  flight?: string;
  r?: string | null;
  t?: string | null;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground" | null;
  alt_geom?: number | null;
  gs?: number | null;
  track?: number | null;
  squawk?: string | null;
  seen?: number;
  emergency?: string;
  category?: string | number | null;
  military?: boolean;
};

type AircraftApiResponse = {
  ac?: AdsbAircraft[];
  now?: number;
  total?: number;
  provider?: string;
  coverage?: "regional" | "worldwide";
  stale?: boolean;
  degraded?: boolean;
  cached?: boolean;
  sourceAgeSeconds?: number;
  latencyMs?: number;
  authMode?: "anonymous" | "oauth" | "anonymous-fallback";
  region?: { latitude: number; longitude: number; radiusNm: number } | null;
  requestedScope?: "global" | "regional";
  source?: "civilian" | "military" | "mixed";
};

export type AircraftQuery = {
  latitude: number;
  longitude: number;
  radiusNm?: number;
  scope?: "global" | "regional";
};

export type AircraftFeedMeta = {
  provider: string;
  coverage: "regional" | "worldwide";
  stale: boolean;
  degraded: boolean;
  cached: boolean;
  sourceAgeSeconds: number | null;
  latencyMs: number | null;
  total: number;
  authMode: "anonymous" | "oauth" | "anonymous-fallback" | null;
  region: { latitude: number; longitude: number; radiusNm: number } | null;
  requestedScope: "global" | "regional";
  source: "civilian" | "military" | "mixed";
};

export type AircraftSnapshot = {
  entities: SpatialEntity[];
  meta: AircraftFeedMeta;
};

function providerSource(provider?: string) {
  switch (provider) {
    case "opensky":
      return { id: "opensky", label: "OpenSky Network", url: "https://opensky-network.org/" };
    default:
      return { id: "adsb-lol", label: "ADSB.lol community ADS-B", url: "https://www.adsb.lol/" };
  }
}

function responseTimeMs(payload: AircraftApiResponse) {
  if (typeof payload.now !== "number") return Date.now();
  return payload.now < 10_000_000_000 ? payload.now * 1000 : payload.now;
}

function normalizeClass(aircraft: AdsbAircraft) {
  const category = Number(aircraft.category);
  const type = String(aircraft.t ?? "").toUpperCase();
  if (/^(H|HELI)|H60|UH60|CH47|AH64|EC\d|AS\d|B06|R22|R44|S76/.test(type)) return "helicopter";
  if (/F16|F18|F35|F22|EUFI|T38|HAWK|L39|M346|FA50/.test(type)) return "fastjet";
  if (/A388|B748|A35|B77|B78|A33|A34/.test(type)) return "widebody";
  if (/AT7|DH8|SF3|BE20|C130/.test(type)) return "turboprop";
  // OpenSky extended category 7 is high-performance / fast aircraft; categories
  // 4-6 cover progressively heavier fixed-wing aircraft.
  if (category === 7) return "fastjet";
  if (category === 6) return "widebody";
  if (category === 2 || category === 3) return "light";
  return "airliner";
}

function buildEntities(payload: AircraftApiResponse, radiusNm: number): SpatialEntity[] {
  const observedResponseMs = responseTimeMs(payload);
  // A degraded feed can still contain fresh observations (for example a fresh
  // regional civilian fallback while global coverage is unavailable). Only an
  // explicitly stale snapshot marks each aircraft STALE.
  const stale = Boolean(payload.stale);

  return (payload.ac ?? []).flatMap((aircraft, index) => {
    if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") return [];
    const baroFeet = typeof aircraft.alt_baro === "number" ? aircraft.alt_baro : null;
    const geomFeet = typeof aircraft.alt_geom === "number" ? aircraft.alt_geom : null;
    const altitudeFeet = geomFeet ?? baroFeet ?? 0;
    const altitudeMeters = Math.max(0, altitudeFeet * 0.3048);
    const seenSeconds = typeof aircraft.seen === "number" ? Math.max(0, aircraft.seen) : 0;
    const hex = aircraft.hex?.trim() || `unknown-${index}`;
    const callsign = aircraft.flight?.trim() || aircraft.r?.trim() || hex.toUpperCase();
    const military = Boolean(aircraft.military || payload.source === "military");

    return [{
      id: `aircraft:${hex}`,
      kind: "aircraft" as const,
      name: callsign,
      position: { longitude: aircraft.lon, latitude: aircraft.lat, altitudeMeters },
      observedAt: new Date(observedResponseMs - seenSeconds * 1000).toISOString(),
      dataState: stale ? "STALE" as const : "OBSERVED" as const,
      source: providerSource(payload.provider),
      properties: {
        provider: payload.provider ?? "unknown",
        hex,
        registration: aircraft.r ?? null,
        aircraftType: aircraft.t ?? null,
        aircraftClass: normalizeClass(aircraft),
        military,
        altitudeFt: Math.round(altitudeFeet),
        groundSpeedKt: typeof aircraft.gs === "number" ? Number(aircraft.gs.toFixed(1)) : null,
        trackDeg: typeof aircraft.track === "number" ? Number(aircraft.track.toFixed(1)) : null,
        squawk: aircraft.squawk ?? null,
        emergency: aircraft.emergency ?? "none",
        category: aircraft.category == null ? null : String(aircraft.category),
        seenSeconds: Number(seenSeconds.toFixed(1)),
        queryRadiusNm: radiusNm,
        coverage: payload.coverage ?? "regional",
        renderModel: "bounded interpolation between observed ADS-B updates",
        feedState: stale ? "degraded-cached" : payload.degraded ? "degraded-live" : "live",
      },
    } satisfies SpatialEntity];
  });
}

function metaFromPayload(payload: AircraftApiResponse, entities: SpatialEntity[], requestedScope: "global" | "regional"): AircraftFeedMeta {
  return {
    provider: payload.provider ?? "unknown",
    coverage: payload.coverage ?? "regional",
    stale: Boolean(payload.stale),
    degraded: Boolean(payload.degraded),
    cached: Boolean(payload.cached),
    sourceAgeSeconds: typeof payload.sourceAgeSeconds === "number" ? payload.sourceAgeSeconds : null,
    latencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : null,
    total: typeof payload.total === "number" ? payload.total : entities.length,
    authMode: payload.authMode ?? null,
    region: payload.region ?? null,
    requestedScope: payload.requestedScope ?? requestedScope,
    source: payload.source ?? "civilian",
  };
}

async function readSnapshot(response: Response, radiusNm: number, requestedScope: "global" | "regional"): Promise<AircraftSnapshot> {
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: string; retryAfterSeconds?: number };
      detail = payload.error ? ` · ${payload.error}` : "";
      if (payload.retryAfterSeconds) detail += ` · retry in ~${payload.retryAfterSeconds}s`;
    } catch {
      // Ignore non-JSON upstream errors.
    }
    throw new Error(`Aircraft proxy returned HTTP ${response.status}${detail}`);
  }

  const payload = await response.json() as AircraftApiResponse;
  const entities = buildEntities(payload, radiusNm);
  return { entities, meta: metaFromPayload(payload, entities, requestedScope) };
}

export async function fetchAircraftSnapshot(query: AircraftQuery, signal?: AbortSignal): Promise<AircraftSnapshot> {
  const radiusNm = Math.max(25, Math.min(250, Math.round(query.radiusNm ?? 220)));
  const lat = Number(query.latitude.toFixed(4));
  const lon = Number(query.longitude.toFixed(4));
  const scope = query.scope === "global" ? "global" : "regional";
  const response = await fetch(`/api/aircraft?lat=${lat}&lon=${lon}&radius=${radiusNm}&scope=${scope}`, { signal, cache: "no-store" });
  return readSnapshot(response, radiusNm, scope);
}

export async function fetchMilitarySnapshot(signal?: AbortSignal): Promise<AircraftSnapshot> {
  const response = await fetch('/api/military', { signal, cache: 'no-store' });
  return readSnapshot(response, 250, 'global');
}

export async function fetchAircraftNear(query: AircraftQuery, signal?: AbortSignal): Promise<SpatialEntity[]> {
  return (await fetchAircraftSnapshot(query, signal)).entities;
}

// Display-only bounded dead-reckoning between actual ADS-B updates. The stored
// entity remains OBSERVED/STALE; this never fabricates a new observation.
export function projectAircraftPosition(entity: SpatialEntity, atMs: number) {
  if (entity.kind !== "aircraft" || entity.dataState === "STALE") return entity.position;
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
