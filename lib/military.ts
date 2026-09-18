import type { SpatialEntity } from "@/lib/spatial";

type ReadsbAircraft = {
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
  category?: string | number | null;
};

type MilitaryApiResponse = {
  ac?: ReadsbAircraft[];
  now?: number;
  total?: number;
  stale?: boolean;
  degraded?: boolean;
  cached?: boolean;
  sourceAgeSeconds?: number;
  retryAfterSeconds?: number;
};

export type MilitaryFeedMeta = {
  provider: "adsb.lol";
  coverage: "worldwide";
  stale: boolean;
  degraded: boolean;
  cached: boolean;
  sourceAgeSeconds: number | null;
  total: number;
};

export type MilitarySnapshot = {
  entities: SpatialEntity[];
  meta: MilitaryFeedMeta;
};

function responseTimeMs(payload: MilitaryApiResponse) {
  if (typeof payload.now !== "number") return Date.now();
  return payload.now < 10_000_000_000 ? payload.now * 1000 : payload.now;
}

export async function fetchMilitarySnapshot(signal?: AbortSignal): Promise<MilitarySnapshot> {
  const response = await fetch("/api/military", { signal, cache: "no-store" });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: string; retryAfterSeconds?: number };
      if (body.error) detail += ` · ${body.error}`;
      if (body.retryAfterSeconds) detail += ` · retry in ~${body.retryAfterSeconds}s`;
    } catch {}
    throw new Error(`Military proxy returned HTTP ${response.status}${detail}`);
  }

  const payload = await response.json() as MilitaryApiResponse;
  const observedResponseMs = responseTimeMs(payload);
  const stale = Boolean(payload.stale || payload.degraded);
  const entities = (payload.ac ?? []).flatMap((aircraft, index) => {
    if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") return [];
    const altitudeFeet =
      (typeof aircraft.alt_geom === "number" ? aircraft.alt_geom : null) ??
      (typeof aircraft.alt_baro === "number" ? aircraft.alt_baro : null) ??
      0;
    const seenSeconds = typeof aircraft.seen === "number" ? Math.max(0, aircraft.seen) : 0;
    const hex = aircraft.hex?.trim() || `unknown-${index}`;
    const callsign = aircraft.flight?.trim() || aircraft.r?.trim() || hex.toUpperCase();

    return [{
      id: `military:${hex}`,
      kind: "aircraft" as const,
      name: callsign,
      position: {
        longitude: aircraft.lon,
        latitude: aircraft.lat,
        altitudeMeters: Math.max(0, altitudeFeet * 0.3048),
      },
      observedAt: new Date(observedResponseMs - seenSeconds * 1000).toISOString(),
      dataState: stale ? "STALE" as const : "OBSERVED" as const,
      source: { id: "adsb-lol-military", label: "ADSB.lol military", url: "https://www.adsb.lol/" },
      properties: {
        provider: "adsb.lol",
        military: true,
        hex,
        registration: aircraft.r ?? null,
        aircraftType: aircraft.t ?? null,
        altitudeFt: Math.round(altitudeFeet),
        groundSpeedKt: typeof aircraft.gs === "number" ? Number(aircraft.gs.toFixed(1)) : null,
        trackDeg: typeof aircraft.track === "number" ? Number(aircraft.track.toFixed(1)) : null,
        squawk: aircraft.squawk ?? null,
        category: aircraft.category == null ? null : String(aircraft.category),
        seenSeconds: Number(seenSeconds.toFixed(1)),
        coverage: "worldwide",
        feedState: stale ? "degraded-cached" : "live",
        renderModel: "bounded interpolation between observed ADS-B updates",
      },
    } satisfies SpatialEntity];
  });

  return {
    entities,
    meta: {
      provider: "adsb.lol",
      coverage: "worldwide",
      stale: Boolean(payload.stale),
      degraded: Boolean(payload.degraded),
      cached: Boolean(payload.cached),
      sourceAgeSeconds: typeof payload.sourceAgeSeconds === "number" ? payload.sourceAgeSeconds : null,
      total: typeof payload.total === "number" ? payload.total : entities.length,
    },
  };
}
