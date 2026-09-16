function bboxForRadius(lat: number, lon: number, radiusNm: number) {
  const latDelta = radiusNm / 60;
  const lonScale = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const lonDelta = radiusNm / (60 * lonScale);
  return {
    lamin: Math.max(-90, lat - latDelta), lamax: Math.min(90, lat + latDelta),
    lomin: Math.max(-180, lon - lonDelta), lomax: Math.min(180, lon + lonDelta),
  };
}

type ProviderResult = { ac: any[]; now: number; total: number; provider: string };
type Provider = { id: string; delayMs: number; run: (lat: number, lon: number, radius: number) => Promise<ProviderResult> };

const PROVIDER_TIMEOUT_MS = 4200;
const providerCooldownUntil = new Map<string, number>();

class ProviderHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setCooldown(providerId: string, error: unknown) {
  const now = Date.now();
  const status = error instanceof ProviderHttpError ? error.status : 0;
  const cooldownMs = status === 429 ? 180_000 : status === 401 || status === 403 ? 900_000 : 45_000;
  providerCooldownUntil.set(providerId, now + cooldownMs);
}

async function fetchJson(url: string, userAgent: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: controller.signal,
      cf: { cacheTtl: 20, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!response.ok) throw new ProviderHttpError(response.status);
    return await response.json() as any;
  } finally {
    clearTimeout(timer);
  }
}

async function adsbLol(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://api.adsb.lol/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radius}`, 'WorldSelect/0.4.5');
  return { ac: Array.isArray(payload?.ac) ? payload.ac : [], now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? payload?.ac?.length ?? 0), provider: 'adsb.lol' };
}

async function airplanesLive(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://api.airplanes.live/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radius}`, 'WorldSelect/0.4.5');
  return { ac: Array.isArray(payload?.ac) ? payload.ac : [], now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? payload?.ac?.length ?? 0), provider: 'airplanes.live' };
}

async function adsbFi(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://opendata.adsb.fi/api/v3/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}`, 'WorldSelect/0.4.5');
  const ac = Array.isArray(payload?.ac) ? payload.ac : Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  return { ac, now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? ac.length), provider: 'adsb.fi' };
}

async function openSky(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const box = bboxForRadius(lat, lon, radius);
  const url = new URL('https://opensky-network.org/api/states/all');
  url.searchParams.set('lamin', box.lamin.toFixed(3));
  url.searchParams.set('lamax', box.lamax.toFixed(3));
  url.searchParams.set('lomin', box.lomin.toFixed(3));
  url.searchParams.set('lomax', box.lomax.toFixed(3));
  const payload = await fetchJson(url.toString(), 'WorldSelect/0.4.5');
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const ac = states.flatMap((s: any[]) => {
    if (!Array.isArray(s) || typeof s[5] !== 'number' || typeof s[6] !== 'number') return [];
    const velocityMs = typeof s[9] === 'number' ? s[9] : null;
    return [{
      hex: String(s[0] ?? ''), flight: typeof s[1] === 'string' ? s[1].trim() : '', r: null, t: null,
      lon: s[5], lat: s[6], alt_baro: typeof s[7] === 'number' ? s[7] / 0.3048 : null,
      alt_geom: typeof s[13] === 'number' ? s[13] / 0.3048 : null,
      gs: velocityMs == null ? null : velocityMs * 1.943844, track: typeof s[10] === 'number' ? s[10] : null,
      squawk: s[14] ?? null, seen: typeof s[4] === 'number' ? Math.max(0, Date.now() / 1000 - s[4]) : 0,
    }];
  });
  return { ac, now: Number(payload?.time ? payload.time * 1000 : Date.now()), total: ac.length, provider: 'opensky' };
}

const PROVIDERS: Provider[] = [
  { id: 'adsb.lol', delayMs: 0, run: adsbLol },
  { id: 'opensky', delayMs: 180, run: openSky },
  { id: 'adsb.fi', delayMs: 650, run: adsbFi },
  { id: 'airplanes.live', delayMs: 900, run: airplanesLive },
];

function bucketCoordinate(value: number, step: number) {
  return Math.round(value / step) * step;
}

function snapshotKey(origin: string, lat: number, lon: number, radius: number) {
  const step = radius <= 80 ? 0.25 : radius <= 150 ? 0.5 : 0.75;
  const bucketLat = bucketCoordinate(lat, step).toFixed(2);
  const bucketLon = bucketCoordinate(lon, step).toFixed(2);
  const radiusBucket = radius <= 80 ? 70 : radius <= 150 ? 130 : 220;
  return new Request(`${origin}/__world-select-cache/aircraft/${bucketLat}/${bucketLon}/${radiusBucket}`, { method: 'GET' });
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Math.max(25, Math.min(250, Math.round(Number(url.searchParams.get('radius') ?? 220))));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: 'invalid coordinates' }, { status: 400 });
  }

  const cache = (caches as any).default;
  const cacheKey = snapshotKey(url.origin, lat, lon, radius);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const age = Number(cached.headers.get('X-World-Select-Age-Ms') ?? 0);
    if (!age || Date.now() - age < 25_000) return cached;
  }

  const now = Date.now();
  const eligible = PROVIDERS.filter((provider) => (providerCooldownUntil.get(provider.id) ?? 0) <= now);
  const providers = eligible.length ? eligible : PROVIDERS.slice(0, 2);
  const startedAt = Date.now();

  const attempts = providers.map((provider) => (async () => {
    if (provider.delayMs) await sleep(provider.delayMs);
    try {
      const result = await provider.run(lat, lon, radius);
      if (!result.ac.length) throw new Error(`${provider.id}: empty`);
      providerCooldownUntil.delete(provider.id);
      return result;
    } catch (error) {
      setCooldown(provider.id, error);
      throw error;
    }
  })());

  let selected: ProviderResult | null = null;
  try {
    selected = await Promise.any(attempts);
  } catch {
    selected = null;
  }

  if (!selected) {
    if (cached) {
      const body = await cached.json() as any;
      return Response.json({ ...body, stale: true, degraded: true, latencyMs: Date.now() - startedAt }, {
        headers: {
          'Cache-Control': 'public, max-age=5, s-maxage=10',
          'X-World-Select-Aircraft-Provider': String(body?.provider ?? 'cached'),
          'X-World-Select-Aircraft-Stale': '1',
        },
      });
    }
    return Response.json({ error: 'aircraft providers unavailable', retryAfterSeconds: 30 }, {
      status: 502,
      headers: { 'Cache-Control': 'public, max-age=5, s-maxage=10' },
    });
  }

  const payload = { ...selected, stale: false, degraded: false, latencyMs: Date.now() - startedAt };
  const response = Response.json(payload, {
    headers: {
      'Cache-Control': 'public, max-age=12, s-maxage=25, stale-while-revalidate=180',
      'X-World-Select-Aircraft-Provider': selected.provider,
      'X-World-Select-Age-Ms': String(Date.now()),
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
