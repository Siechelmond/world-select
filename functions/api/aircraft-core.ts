export type AircraftRecord = {
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

export type AircraftCoverage = "regional" | "worldwide";

export type ProviderResult = {
  ac: AircraftRecord[];
  now: number;
  total: number;
  provider: "adsb.lol" | "opensky";
  coverage: AircraftCoverage;
  authMode?: "anonymous" | "oauth" | "anonymous-fallback";
  source?: "civilian" | "military" | "mixed";
};

export function bboxForRadius(lat: number, lon: number, radiusNm: number) {
  const latDelta = radiusNm / 60;
  const lonScale = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const lonDelta = radiusNm / (60 * lonScale);
  return {
    lamin: Math.max(-90, lat - latDelta),
    lamax: Math.min(90, lat + latDelta),
    lomin: Math.max(-180, lon - lonDelta),
    lomax: Math.min(180, lon + lonDelta),
  };
}

export function buildAdsbLolUrl(lat: number, lon: number, radiusNm: number) {
  const radius = Math.max(25, Math.min(250, Math.round(radiusNm)));
  return `https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}`;
}

export function sourceEpochMs(value: unknown, fallbackMs = Date.now()) {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

export function sourceAgeSeconds(epochMs: number, nowMs = Date.now()) {
  return Math.max(0, Math.round((nowMs - epochMs) / 1000));
}

export function normalizeOpenSkyStates(payload: any, coverage: AircraftCoverage = "regional"): ProviderResult {
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const ac = states.flatMap((state: any[]) => {
    if (!Array.isArray(state) || typeof state[5] !== "number" || typeof state[6] !== "number") return [];
    const velocityMs = typeof state[9] === "number" ? state[9] : null;
    return [{
      hex: String(state[0] ?? "").trim(),
      flight: typeof state[1] === "string" ? state[1].trim() : "",
      r: null,
      t: null,
      lon: state[5],
      lat: state[6],
      alt_baro: typeof state[7] === "number" ? state[7] / 0.3048 : null,
      alt_geom: typeof state[13] === "number" ? state[13] / 0.3048 : null,
      gs: velocityMs == null ? null : velocityMs * 1.943844,
      track: typeof state[10] === "number" ? state[10] : null,
      squawk: state[14] ?? null,
      seen: typeof state[4] === "number" ? Math.max(0, Date.now() / 1000 - state[4]) : 0,
      category: state[17] ?? null,
      military: false,
    } satisfies AircraftRecord];
  });
  return {
    ac,
    now: sourceEpochMs(payload?.time),
    total: ac.length,
    provider: "opensky",
    coverage,
    source: "civilian",
  };
}

export function normalizeAdsbLol(payload: any, options: { military?: boolean; coverage?: AircraftCoverage } = {}): ProviderResult {
  const military = Boolean(options.military);
  const ac = (Array.isArray(payload?.ac) ? payload.ac : []).map((record: AircraftRecord) => ({
    ...record,
    military: military || Boolean(record?.military),
  }));
  return {
    ac,
    now: sourceEpochMs(payload?.now),
    total: Number(payload?.total ?? ac.length),
    provider: "adsb.lol",
    coverage: options.coverage ?? "regional",
    source: military ? "military" : "civilian",
  };
}

export function isUsableSnapshot(result: ProviderResult, maxAgeSeconds = 120, nowMs = Date.now()) {
  if (!result.ac.length) return false;
  return sourceAgeSeconds(sourceEpochMs(result.now), nowMs) <= maxAgeSeconds;
}
