import {
  bboxForRadius,
  buildAdsbLolUrl,
  isUsableSnapshot,
  normalizeAdsbLol,
  normalizeOpenSkyStates,
  sourceAgeSeconds,
  sourceEpochMs,
  type ProviderResult,
} from "./aircraft-core";

type Env = {
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;
  OPENSKY_AUTH_MODE?: string;
};

type ProviderName = "adsb.lol" | "opensky";
type Attempt = { provider: ProviderName; ok: boolean; status?: number; message?: string };

const PROVIDER_TIMEOUT_MS = 5_000;
const OPEN_SKY_MAX_SOURCE_AGE_SECONDS = 120;
const FRESH_EDGE_CACHE_MS = 30_000;
const OPEN_SKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

let openSkyTokenCache: { token: string; expiresAtMs: number } | null = null;

class ProviderHttpError extends Error {
  status: number;
  constructor(status: number, provider: ProviderName) {
    super(`${provider} HTTP ${status}`);
    this.status = status;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function openSkyMode(env: Env): "oauth" | "anonymous" | "disabled" {
  const requested = (env.OPENSKY_AUTH_MODE ?? "auto").toLowerCase();
  if (requested === "off" || requested === "disabled") return "disabled";
  if (requested === "anon" || requested === "anonymous") return "anonymous";
  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) return "oauth";
  return "disabled";
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getOpenSkyToken(env: Env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  const now = Date.now();
  if (openSkyTokenCache && openSkyTokenCache.expiresAtMs - 30_000 > now) return openSkyTokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.OPENSKY_CLIENT_ID,
    client_secret: env.OPENSKY_CLIENT_SECRET,
  });
  const response = await fetchWithTimeout(OPEN_SKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  }, 5_000);
  if (!response.ok) throw new ProviderHttpError(response.status, "opensky");
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("opensky token missing");
  openSkyTokenCache = {
    token: payload.access_token,
    expiresAtMs: now + Math.max(60, Number(payload.expires_in ?? 1800)) * 1000,
  };
  return openSkyTokenCache.token;
}

async function fetchOpenSky(lat: number, lon: number, radiusNm: number, env: Env): Promise<ProviderResult> {
  const box = bboxForRadius(lat, lon, radiusNm);
  const url = new URL("https://opensky-network.org/api/states/all");
  url.searchParams.set("lamin", box.lamin.toFixed(3));
  url.searchParams.set("lamax", box.lamax.toFixed(3));
  url.searchParams.set("lomin", box.lomin.toFixed(3));
  url.searchParams.set("lomax", box.lomax.toFixed(3));

  const authMode = openSkyMode(env);
  if (authMode === "disabled") throw new Error("opensky disabled");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authMode === "oauth") {
    const token = await getOpenSkyToken(env);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response = await fetchWithTimeout(url.toString(), {
    headers,
    cf: { cacheTtl: 20, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

  if (response.status === 401 && authMode === "oauth") {
    openSkyTokenCache = null;
    const token = await getOpenSkyToken(env);
    response = await fetchWithTimeout(url.toString(), {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      cf: { cacheTtl: 20, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  }

  if (!response.ok) throw new ProviderHttpError(response.status, "opensky");
  const result = normalizeOpenSkyStates(await response.json());
  result.authMode = authMode;
  return result;
}

async function fetchAdsbLol(lat: number, lon: number, radiusNm: number): Promise<ProviderResult> {
  const response = await fetchWithTimeout(buildAdsbLolUrl(lat, lon, radiusNm), {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 20, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new ProviderHttpError(response.status, "adsb.lol");
  return normalizeAdsbLol(await response.json());
}

function bucketCoordinate(value: number, step: number) {
  return Math.round(value / step) * step;
}

function snapshotKey(origin: string, lat: number, lon: number, radius: number) {
  const step = radius <= 80 ? 0.25 : radius <= 150 ? 0.5 : 0.75;
  const bucketLat = bucketCoordinate(lat, step).toFixed(2);
  const bucketLon = bucketCoordinate(lon, step).toFixed(2);
  const radiusBucket = radius <= 80 ? 70 : radius <= 150 ? 130 : 220;
  return new Request(`${origin}/__world-select-cache/aircraft/${bucketLat}/${bucketLon}/${radiusBucket}`, { method: "GET" });
}

function attemptFailure(provider: ProviderName, error: unknown): Attempt {
  if (error instanceof ProviderHttpError) return { provider, ok: false, status: error.status, message: `HTTP ${error.status}` };
  if (error instanceof Error && error.name === "AbortError") return { provider, ok: false, message: "timeout" };
  return { provider, ok: false, message: "unavailable" };
}

async function tryProvider(provider: ProviderName, lat: number, lon: number, radius: number, env: Env, attempts: Attempt[]) {
  try {
    const result = provider === "opensky"
      ? await fetchOpenSky(lat, lon, radius, env)
      : await fetchAdsbLol(lat, lon, radius);
    attempts.push({ provider, ok: true });
    return result;
  } catch (error) {
    attempts.push(attemptFailure(provider, error));
    return null;
  }
}

function responsePayload(result: ProviderResult, options: {
  stale: boolean;
  degraded: boolean;
  cached?: boolean;
  latencyMs: number;
  lat: number;
  lon: number;
  radius: number;
  attempts?: Attempt[];
}) {
  const epochMs = sourceEpochMs(result.now);
  return {
    ...result,
    now: epochMs,
    stale: options.stale,
    degraded: options.degraded,
    cached: Boolean(options.cached),
    sourceAgeSeconds: sourceAgeSeconds(epochMs),
    latencyMs: options.latencyMs,
    region: { latitude: options.lat, longitude: options.lon, radiusNm: options.radius },
    attempts: options.attempts,
  };
}

export const onRequestGet = async (context: { request: Request; env: Env; waitUntil: (promise: Promise<unknown>) => void }) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Math.max(25, Math.min(250, Math.round(Number(url.searchParams.get("radius") ?? 220))));
  const mode = url.searchParams.get("mode");

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return json({ error: "invalid coordinates" }, 400);
  }

  const cache = (caches as any).default;
  const cacheKey = snapshotKey(url.origin, lat, lon, radius);
  const cached = await cache.match(cacheKey);
  if (cached && mode !== "status") {
    const cachedAt = Number(cached.headers.get("X-World-Select-Cached-At") ?? 0);
    if (cachedAt > 0 && Date.now() - cachedAt < FRESH_EDGE_CACHE_MS) return cached;
  }

  const startedAt = Date.now();
  const attempts: Attempt[] = [];
  const modeForOpenSky = openSkyMode(context.env);
  const oauthAvailable = Boolean(context.env.OPENSKY_CLIENT_ID && context.env.OPENSKY_CLIENT_SECRET) && modeForOpenSky === "oauth";
  const providerOrder: ProviderName[] = oauthAvailable
    ? ["opensky", "adsb.lol"]
    : modeForOpenSky === "anonymous"
      ? ["adsb.lol", "opensky"]
      : ["adsb.lol"];

  let firstNonEmptyStale: ProviderResult | null = null;
  let selected: ProviderResult | null = null;

  for (const provider of providerOrder) {
    const result = await tryProvider(provider, lat, lon, radius, context.env, attempts);
    if (!result || !result.ac.length) continue;
    if (isUsableSnapshot(result, OPEN_SKY_MAX_SOURCE_AGE_SECONDS)) {
      selected = result;
      break;
    }
    firstNonEmptyStale ??= result;
  }

  if (!selected && firstNonEmptyStale) {
    const payload = responsePayload(firstNonEmptyStale, {
      stale: true,
      degraded: true,
      latencyMs: Date.now() - startedAt,
      lat, lon, radius,
      attempts: mode === "status" ? attempts : undefined,
    });
    return json(payload, 200, {
      "Cache-Control": "public, max-age=5, s-maxage=10",
      "X-World-Select-Aircraft-Provider": firstNonEmptyStale.provider,
      "X-World-Select-Aircraft-Stale": "1",
    });
  }

  if (!selected) {
    if (cached) {
      const body = await cached.json() as any;
      const payload = {
        ...body,
        stale: true,
        degraded: true,
        cached: true,
        latencyMs: Date.now() - startedAt,
        attempts: mode === "status" ? attempts : undefined,
      };
      return json(payload, 200, {
        "Cache-Control": "public, max-age=5, s-maxage=10",
        "X-World-Select-Aircraft-Provider": String(body?.provider ?? "cached"),
        "X-World-Select-Aircraft-Stale": "1",
      });
    }
    return json({
      error: "aircraft providers unavailable",
      providerOrder,
      attempts,
      retryAfterSeconds: 30,
    }, 502);
  }

  const payload = responsePayload(selected, {
    stale: false,
    degraded: false,
    latencyMs: Date.now() - startedAt,
    lat, lon, radius,
    attempts: mode === "status" ? attempts : undefined,
  });
  const response = Response.json(payload, {
    headers: {
      "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=180",
      "X-World-Select-Aircraft-Provider": selected.provider,
      "X-World-Select-Cached-At": String(Date.now()),
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
