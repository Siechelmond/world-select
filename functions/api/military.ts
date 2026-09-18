const FRESH_MS = 15_000;
const STALE_MAX_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_SERVER_COOLDOWN_MS = 30_000;
const DEFAULT_NETWORK_COOLDOWN_MS = 15_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function snapshotKey(origin: string) {
  return new Request(`${origin}/__world-select-cache/military/global`, { method: "GET" });
}

function cooldownKey(origin: string) {
  return new Request(`${origin}/__world-select-cache/military/cooldown`, { method: "GET" });
}

function retryAfterMs(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5 * 60_000);
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return Math.max(0, Math.min(parsed - now, 5 * 60_000));
  return null;
}

async function readCooldown(cache: Cache, origin: string, now: number) {
  const cached = await cache.match(cooldownKey(origin));
  if (!cached) return 0;
  const until = Number(cached.headers.get("X-World-Select-Cooldown-Until") ?? 0);
  return until > now ? until : 0;
}

async function writeCooldown(cache: Cache, origin: string, until: number, waitUntil: (promise: Promise<unknown>) => void) {
  const marker = new Response("", {
    status: 204,
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-World-Select-Cooldown-Until": String(until),
    },
  });
  waitUntil(cache.put(cooldownKey(origin), marker));
}

async function staleFromCache(cached: Response | undefined, cachedAt: number, now: number, reason: string) {
  if (!cached || !cachedAt || now - cachedAt > STALE_MAX_MS) return null;
  try {
    const payload = await cached.clone().json() as Record<string, unknown>;
    return json({
      ...payload,
      stale: true,
      degraded: true,
      cached: true,
      sourceAgeSeconds: Math.max(0, Math.round((now - cachedAt) / 1000)),
      degradedReason: reason,
    }, 200, {
      "X-World-Select-Military-Cache": "STALE",
      "X-World-Select-Cached-At": String(cachedAt),
    });
  } catch {
    return null;
  }
}

export const onRequestGet = async (context: {
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const url = new URL(context.request.url);
  const cache = (caches as any).default as Cache;
  const key = snapshotKey(url.origin);
  const cached = await cache.match(key);
  const cachedAt = Number(cached?.headers.get("X-World-Select-Cached-At") ?? 0);
  const now = Date.now();

  if (cached && cachedAt > 0 && now - cachedAt < FRESH_MS) return cached;

  const cooldownUntil = await readCooldown(cache, url.origin, now);
  if (cooldownUntil > now) {
    const stale = await staleFromCache(cached ?? undefined, cachedAt, now, "adsb.lol military provider cooling down");
    if (stale) return stale;
    return json({
      error: "military provider cooling down",
      provider: "adsb.lol",
      retryAfterSeconds: Math.max(1, Math.ceil((cooldownUntil - now) / 1000)),
    }, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch("https://api.adsb.lol/v2/mil", {
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldSelect-ws-pv/2.1 (+https://world-select.pages.dev)",
      },
      signal: controller.signal,
      cf: { cacheTtl: 12, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

    if (!upstream.ok) {
      const explicitRetry = retryAfterMs(upstream.headers.get("Retry-After"), now);
      const cooldownMs = upstream.status === 429
        ? (explicitRetry ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS)
        : upstream.status >= 500
          ? (explicitRetry ?? DEFAULT_SERVER_COOLDOWN_MS)
          : 0;

      if (cooldownMs > 0) {
        await writeCooldown(cache, url.origin, now + cooldownMs, context.waitUntil);
      }

      const stale = await staleFromCache(
        cached ?? undefined,
        cachedAt,
        now,
        `adsb.lol military HTTP ${upstream.status}`,
      );
      if (stale) return stale;

      return json({
        error: `adsb.lol military HTTP ${upstream.status}`,
        provider: "adsb.lol",
        retryAfterSeconds: cooldownMs > 0 ? Math.max(1, Math.ceil(cooldownMs / 1000)) : undefined,
      }, upstream.status === 429 ? 429 : 502);
    }

    const payload = await upstream.json() as { ac?: unknown[]; now?: number; total?: number };
    if (!Array.isArray(payload.ac)) throw new Error("Malformed adsb.lol military response");

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
        "Cache-Control": "public, max-age=10, s-maxage=15, stale-while-revalidate=180",
        "X-World-Select-Cached-At": String(Date.now()),
        "X-World-Select-Military-Cache": "MISS",
      },
    });

    context.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (error) {
    const cooldownMs = DEFAULT_NETWORK_COOLDOWN_MS;
    await writeCooldown(cache, url.origin, now + cooldownMs, context.waitUntil);

    const reason = error instanceof Error && error.name === "AbortError"
      ? "adsb.lol military timeout"
      : "adsb.lol military unavailable";

    const stale = await staleFromCache(cached ?? undefined, cachedAt, now, reason);
    if (stale) return stale;

    return json({
      error: reason,
      provider: "adsb.lol",
      retryAfterSeconds: Math.ceil(cooldownMs / 1000),
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
};
