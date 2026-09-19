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
type ProviderPhase = "oauth-token" | "states" | "snapshot";
type Attempt = {
  provider: ProviderName;
  ok: boolean;
  status?: number;
  message?: string;
  phase?: ProviderPhase;
  elapsedMs?: number;
  authMode?: "anonymous" | "oauth" | "anonymous-fallback";
};

const OPEN_SKY_TOKEN_TIMEOUT_MS = 5_000;
const OPEN_SKY_STATES_TIMEOUT_MS = 6_000;
const ADSB_LOL_TIMEOUT_MS = 5_000;
const OPEN_SKY_MAX_SOURCE_AGE_SECONDS = 120;
const FRESH_EDGE_CACHE_MS = 30_000;
const OPEN_SKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

let openSkyTokenCache: { token: string; expiresAtMs: number } | null = null;

class ProviderHttpError extends Error {
  status: number;
  provider: ProviderName;
  phase: ProviderPhase;
  constructor(status: number, provider: ProviderName, phase: ProviderPhase) {
    super(`${provider} HTTP ${status}`);
    this.status = status;
    this.provider = provider;
    this.phase = phase;
  }
}

class ProviderTimeoutError extends Error {
  provider: ProviderName;
  phase: ProviderPhase;
  constructor(provider: ProviderName, phase: ProviderPhase) {
    super(`${provider} ${phase} timeout`);
    this.name = "ProviderTimeoutError";
    this.provider = provider;
    this.phase = phase;
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
  // Keyless OpenSky is a supported, lower-quota mode and is safer than silently
  // disabling the primary provider when credentials are missing.
  return "anonymous";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: ProviderName,
  phase: ProviderPhase,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderTimeoutError(provider, phase);
    }
    throw error;
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
  }, OPEN_SKY_TOKEN_TIMEOUT_MS, "opensky", "oauth-token");
  if (!response.ok) throw new ProviderHttpError(response.status, "opensky", "oauth-token");
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("opensky token missing");
  openSkyTokenCache = {
    token: payload.access_token,
    expiresAtMs: now + Math.max(60, Number(payload.expires_in ?? 1800)) * 1000,
  };
  return openSkyTokenCache.token;
}

function openSkyStateUrl(lat: number, lon: number, radiusNm: number) {
  const box = bboxForRadius(lat, lon, radiusNm);
  const url = new URL("https://opensky-network.org/api/states/all");
  url.searchParams.set("lamin", box.lamin.toFixed(3));
  url.searchParams.set("lamax", box.lamax.toFixed(3));
  url.searchParams.set("lomin", box.lomin.toFixed(3));
  url.searchParams.set("lomax", box.lomax.toFixed(3));
  return url;
}

async function fetchOpenSkyStates(
  url: URL,
  headers: Record<string, string>,
  authMode: "anonymous" | "oauth" | "anonymous-fallback",
): Promise<ProviderResult> {
  const response = await fetchWithTimeout(url.toString(), {
    headers,
    cf: { cacheTtl: 20, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } }, OPEN_SKY_STATES_TIMEOUT_MS, "opensky", "states");
  if (!response.ok) throw new ProviderHttpError(response.status, "opensky", "states");
  const result = normalizeOpenSkyStates(await response.json());
  result.authMode = authMode;
  return result;
}

async function fetchOpenSky(lat: number, lon: number, radiusNm: number, env: Env): Promise<ProviderResult> {
  const url = openSkyStateUrl(lat, lon, radiusNm);
  const authMode = openSkyMode(env);
  if (authMode === "disabled") throw new Error("opensky disabled");

  if (authMode === "anonymous") {
    return fetchOpenSkyStates(url, { Accept: "application/json" }, "anonymous");
  }

  // OAuth is preferred when configured. If only the OAuth token broker is slow or
  // unavailable, fall back to OpenSky's supported anonymous mode before leaving
  // the provider entirely. This avoids a cold-start token timeout turning the
  // whole layer into Unavailable.
  let token: string | null = null;
  try {
    token = await getOpenSkyToken(env);
  } catch (error) {
    if (error instanceof ProviderTimeoutError || (error instanceof ProviderHttpError && error.phase === "oauth-token")) {
      return fetchOpenSkyStates(url, { Accept: "application/json" }, "anonymous-fallback");
    }
    throw error;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    return await fetchOpenSkyStates(url, headers, "oauth");
  } catch (error) {
    if (error instanceof ProviderHttpError && error.status === 401) {
      openSkyTokenCache = null;
      const refreshed = await getOpenSkyToken(env);
      if (refreshed) {
        return fetchOpenSkyStates(url, { Accept: "application/json", Authorization: `Bearer ${refreshed}` }, "oauth");
      }
    }
    throw error;
  }
}

async function fetchAdsbLol(lat: number, lon: number, radiusNm: number): Promise<ProviderResult> {
  const response = await fetchWithTimeout(buildAdsbLolUrl(lat, lon, radiusNm), {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldSelect/5.1 (+https://world-select.pages.dev)",
    },
    cf: { cacheTtl: 20, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } }, ADSB_LOL_TIMEOUT_MS, "adsb.lol", "snapshot");
  if (!response.ok) throw new ProviderHttpError(response.status, "adsb.lol", "snapshot");
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

function attemptFailure(provider: ProviderName, error: unknown, elapsedMs: number): Attempt {
  if (error instanceof ProviderHttpError) {
    return { provider, ok: false, status: error.status, message: `HTTP ${error.status}`, phase: error.phase, elapsedMs };
  }
  if (error instanceof ProviderTimeoutError) {
    return { provider, ok: false, message: "timeout", phase: error.phase, elapsedMs };
  }
  return { provider, ok: false, message: "unavailable", elapsedMs };
}

async function tryProvider(provider: ProviderName, lat: number, lon: number, radius: number, env: Env, attempts: Attempt[]) {
  const startedAt = Date.now();
  try {
    const result = provider === "opensky"
      ? await fetchOpenSky(lat, lon, radius, env)
      : await fetchAdsbLol(lat, lon, radius);
    attempts.push({ provider, ok: true, elapsedMs: Date.now() - startedAt, authMode: result.authMode });
    return result;
  } catch (error) {
    attempts.push(attemptFailure(provider, error, Date.now() - startedAt));
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
  const providerOrder: ProviderName[] = modeForOpenSky === "disabled"
    ? ["adsb.lol"]
    : ["opensky", "adsb.lol"];

  let firstNonEmptyStale: ProviderResult | null = null;
  let selected: ProviderResult | null = null;

  // Start all allowed providers together. The former serial OpenSky -> ADSB
  // chain could spend ~20s waiting before a usable fallback was even tried.
  const pending = new Map<ProviderName, Promise<{ provider: ProviderName; result: ProviderResult | null }>>();
  for (const provider of providerOrder) {
    pending.set(
      provider,
      tryProvider(provider, lat, lon, radius, context.env, attempts)
        .then((result) => ({ provider, result })),
    );
  }

  while (pending.size && !selected) {
    const completed = await Promise.race([...pending.values()]);
    pending.delete(completed.provider);
    const result = completed.result;
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
      openSkyAuthMode: modeForOpenSky,
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
