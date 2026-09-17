import { normalizeAdsbLol, sourceAgeSeconds, sourceEpochMs } from './aircraft-core';

type Attempt = { ok: boolean; status?: number; message?: string; elapsedMs: number };
const TIMEOUT_MS = 6_000;
const FRESH_MS = 12_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export const onRequestGet = async (context: { request: Request; waitUntil: (promise: Promise<unknown>) => void }) => {
  const url = new URL(context.request.url);
  const mode = url.searchParams.get('mode');
  const cache = (caches as any).default;
  const cacheKey = new Request(`${url.origin}/__world-select-cache/aircraft/military-global`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached && mode !== 'status') {
    const cachedAt = Number(cached.headers.get('X-World-Select-Cached-At') ?? 0);
    if (cachedAt > 0 && Date.now() - cachedAt < FRESH_MS) return cached;
  }

  const started = Date.now();
  const attempt: Attempt = { ok: false, elapsedMs: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch('https://api.adsb.lol/v2/mil', {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'WorldSelect/0.7 (+https://world-select.pages.dev)' },
      cf: { cacheTtl: 12, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    attempt.elapsedMs = Date.now() - started;
    attempt.status = upstream.status;
    if (!upstream.ok) throw new Error(`adsb.lol military HTTP ${upstream.status}`);
    const result = normalizeAdsbLol(await upstream.json(), { military: true, coverage: 'worldwide' });
    attempt.ok = true;
    const epochMs = sourceEpochMs(result.now);
    const payload = {
      ...result,
      now: epochMs,
      stale: false,
      degraded: false,
      cached: false,
      sourceAgeSeconds: sourceAgeSeconds(epochMs),
      latencyMs: Date.now() - started,
      attempts: mode === 'status' ? [attempt] : undefined,
    };
    const response = Response.json(payload, {
      headers: {
        'Cache-Control': 'public, max-age=8, s-maxage=12, stale-while-revalidate=120',
        'X-World-Select-Cached-At': String(Date.now()),
        'X-World-Select-Aircraft-Provider': 'adsb.lol',
        'X-World-Select-Aircraft-Coverage': 'worldwide',
      },
    });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (reason: unknown) {
    attempt.elapsedMs = Date.now() - started;
    attempt.message = reason instanceof Error && reason.name === 'AbortError' ? 'timeout' : reason instanceof Error ? reason.message : 'unavailable';
    if (cached) {
      const body = await cached.json() as any;
      return json({
        ...body,
        stale: true,
        degraded: true,
        cached: true,
        latencyMs: Date.now() - started,
        attempts: mode === 'status' ? [attempt] : undefined,
      }, 200, {
        'Cache-Control': 'public, max-age=5, s-maxage=10',
        'X-World-Select-Aircraft-Stale': '1',
      });
    }
    return json({ error: 'military aircraft provider unavailable', attempts: [attempt], retryAfterSeconds: 30 }, 502);
  } finally {
    clearTimeout(timeout);
  }
};
