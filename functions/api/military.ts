const FRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 6_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function cacheKey(origin: string) {
  return new Request(`${origin}/__world-select-cache/military/global`, { method: "GET" });
}

export const onRequestGet = async (context: {
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const url = new URL(context.request.url);
  const cache = (caches as any).default as Cache;
  const key = cacheKey(url.origin);
  const cached = await cache.match(key);
  const cachedAt = Number(cached?.headers.get("X-World-Select-Cached-At") ?? 0);
  const now = Date.now();

  if (cached && cachedAt > 0 && now - cachedAt < FRESH_MS) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch("https://api.adsb.lol/v2/mil", {
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldSelect-ws-pv/2.0 (+https://world-select.pages.dev)",
      },
      signal: controller.signal,
      cf: { cacheTtl: 12, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

    if (!upstream.ok) throw new Error(`adsb.lol military HTTP ${upstream.status}`);
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
  } catch (reason: unknown) {
    if (cached) {
      const body = await cached.clone().json() as Record<string, unknown>;
      return json({
        ...body,
        stale: true,
        degraded: true,
        cached: true,
        sourceAgeSeconds: cachedAt > 0 ? Math.round((Date.now() - cachedAt) / 1000) : null,
      }, 200, {
        "Cache-Control": "public, max-age=5, s-maxage=10, stale-while-revalidate=300",
        "X-World-Select-Military-Cache": "STALE",
      });
    }
    const message = reason instanceof Error && reason.name === "AbortError"
      ? "adsb.lol military timeout"
      : reason instanceof Error ? reason.message : "adsb.lol military unavailable";
    return json({ error: message, retryAfterSeconds: 20 }, 502);
  } finally {
    clearTimeout(timeout);
  }
};
