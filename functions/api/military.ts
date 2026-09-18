let cooldownUntil = 0;
let cooldownStatus = 0;

const CACHE_TTL_MS = 12_000;
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 15_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(120_000, Math.max(5_000, seconds * 1000));
    const date = Date.parse(raw);
    if (Number.isFinite(date) && date > Date.now()) return Math.min(120_000, Math.max(5_000, date - Date.now()));
  }
  return response.status === 429 ? DEFAULT_RATE_LIMIT_COOLDOWN_MS : DEFAULT_SERVER_ERROR_COOLDOWN_MS;
}

function cacheKey(origin: string) {
  return new Request(`${origin}/__world-select-cache/military/global`, { method: "GET" });
}

async function readCached(cache: Cache, key: Request) {
  const response = await cache.match(key);
  if (!response) return null;
  const cachedAt = Number(response.headers.get("X-World-Select-Cached-At") ?? 0);
  return { response, cachedAt };
}

export const onRequestGet = async (context: {
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const url = new URL(context.request.url);
  const cache = (caches as any).default as Cache;
  const key = cacheKey(url.origin);
  const cached = await readCached(cache, key);
  const now = Date.now();

  if (cached && cached.cachedAt > 0 && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.response;
  }

  if (now < cooldownUntil) {
    if (cached) {
      const payload = await cached.response.clone().json() as Record<string, unknown>;
      return json({
        ...payload,
        stale: true,
        degraded: true,
        cached: true,
        sourceAgeSeconds: cached.cachedAt > 0 ? Math.round((now - cached.cachedAt) / 1000) : null,
        retryAfterSeconds: Math.ceil((cooldownUntil - now) / 1000),
      }, 200, {
        "X-World-Select-Military-Cache": "STALE",
        "X-World-Select-Upstream-Status": String(cooldownStatus),
      });
    }
    return json({
      error: "adsb.lol military upstream cooling down",
      retryAfterSeconds: Math.ceil((cooldownUntil - now) / 1000),
    }, cooldownStatus || 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch("https://api.adsb.lol/v2/mil", {
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldSelect-ws-pv/1.0 (+https://world-select.pages.dev)",
      },
      signal: controller.signal,
      cf: { cacheTtl: 10, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

    if (upstream.ok) {
      const payload = await upstream.json() as { ac?: unknown[]; now?: number; total?: number };
      if (!Array.isArray(payload.ac)) throw new Error("Malformed adsb.lol military response");
      cooldownUntil = 0;
      cooldownStatus = 0;
      const body = {
        ...payload,
        provider: "adsb.lol",
        coverage: "worldwide",
        stale: false,
        degraded: false,
        cached: false,
        sourceAgeSeconds: 0,
        total: typeof payload.total === "number" ? payload.total : payload.ac.length,
      };
      const response = Response.json(body, {
        headers: {
          "Cache-Control": "public, max-age=8, s-maxage=12, stale-while-revalidate=120",
          "X-World-Select-Cached-At": String(Date.now()),
          "X-World-Select-Military-Cache": "MISS",
        },
      });
      context.waitUntil(cache.put(key, response.clone()));
      return response;
    }

    if (upstream.status === 429 || upstream.status >= 500) {
      cooldownStatus = upstream.status;
      cooldownUntil = Date.now() + retryAfterMs(upstream);
      upstream.body?.cancel().catch(() => {});
    }

    if (cached) {
      const payload = await cached.response.clone().json() as Record<string, unknown>;
      return json({
        ...payload,
        stale: true,
        degraded: true,
        cached: true,
        sourceAgeSeconds: cached.cachedAt > 0 ? Math.round((Date.now() - cached.cachedAt) / 1000) : null,
        retryAfterSeconds: cooldownUntil > Date.now() ? Math.ceil((cooldownUntil - Date.now()) / 1000) : undefined,
      }, 200, {
        "X-World-Select-Military-Cache": "STALE",
        "X-World-Select-Upstream-Status": String(upstream.status),
      });
    }

    return json({ error: `adsb.lol military HTTP ${upstream.status}` }, 502);
  } catch (error) {
    if (cached) {
      const payload = await cached.response.clone().json() as Record<string, unknown>;
      return json({
        ...payload,
        stale: true,
        degraded: true,
        cached: true,
        sourceAgeSeconds: cached.cachedAt > 0 ? Math.round((Date.now() - cached.cachedAt) / 1000) : null,
      }, 200, { "X-World-Select-Military-Cache": "STALE" });
    }
    const message = error instanceof Error && error.name === "AbortError"
      ? "adsb.lol military timeout"
      : error instanceof Error ? error.message : "adsb.lol military unavailable";
    return json({ error: message, retryAfterSeconds: 30 }, 502);
  } finally {
    clearTimeout(timeout);
  }
};
