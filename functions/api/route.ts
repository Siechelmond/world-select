type RouteProfile = 'foot' | 'car' | 'bike';

type CacheRecord = {
  payload: unknown;
  cachedAt: number;
};

const ROUTE_CACHE_MS = 10 * 60_000;
const ROUTE_TIMEOUT_MS = 12_000;
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;
const routeCache = new Map<string, CacheRecord>();
const routeInFlight = new Map<string, Promise<unknown>>();
let nextUpstreamAt = 0;
let queueDepth = 0;
const UPSTREAM_MIN_INTERVAL_MS = 1000;
const QUEUE_MAX = 8;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeProfile(value: string | null): RouteProfile | null {
  const raw = String(value ?? 'foot').trim().toLowerCase();
  if (raw === 'foot' || raw === 'walking' || raw === 'walk') return 'foot';
  if (raw === 'car' || raw === 'driving' || raw === 'drive') return 'car';
  if (raw === 'bike' || raw === 'cycling' || raw === 'bicycle') return 'bike';
  return null;
}

async function throughGate<T>(run: () => Promise<T>): Promise<T> {
  if (queueDepth >= QUEUE_MAX) throw new Error('routing busy');
  queueDepth += 1;
  try {
    const now = Date.now();
    const slot = Math.max(now, nextUpstreamAt);
    nextUpstreamAt = slot + UPSTREAM_MIN_INTERVAL_MS;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
    return await run();
  } finally {
    queueDepth -= 1;
  }
}

async function fetchRoute(profile: RouteProfile, coords: string) {
  const osrmProfile = profile === 'car' ? 'driving' : profile;
  const base = `https://routing.openstreetmap.de/routed-${profile}`;
  const upstream = `${base}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const response = await throughGate(() => fetch(upstream, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WorldSelect/0.7 (+https://world-select.pages.dev)',
      },
    }));
    if (response.status === 429) {
      const retry = Number(response.headers.get('Retry-After'));
      throw Object.assign(new Error('routing service rate limited'), { retryAfter: Number.isFinite(retry) ? retry : 5 });
    }
    if (!response.ok) throw new Error(`routing upstream HTTP ${response.status}`);
    const payload = await response.json() as any;
    const route = payload?.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (payload?.code !== 'Ok' || !Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error('no route found');
    }
    return {
      ok: true,
      profile,
      distanceM: Number(route.distance ?? 0),
      durationS: Number(route.duration ?? 0),
      coordinates: coordinates
        .filter((item: unknown) => Array.isArray(item) && item.length >= 2 && Number.isFinite(Number(item[0])) && Number.isFinite(Number(item[1])))
        .map((item: any[]) => [Number(item[0]), Number(item[1])]),
      provider: 'OSRM / OpenStreetMap',
      coverage: 'street-network',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const onRequestGet = async (context: { request: Request }) => {
  const url = new URL(context.request.url);
  const profile = normalizeProfile(url.searchParams.get('profile'));
  if (!profile) return json({ ok: false, error: 'invalid profile' }, 400);

  const pairs = (url.searchParams.get('coords') ?? '').split(';').map((item) => item.trim()).filter(Boolean);
  if (pairs.length < 2 || pairs.length > 12) return json({ ok: false, error: 'need 2-12 coordinates' }, 400);

  const points: Array<[number, number]> = [];
  const clean: string[] = [];
  for (const pair of pairs) {
    const parts = pair.split(',');
    if (parts.length !== 2) return json({ ok: false, error: 'invalid coordinate' }, 400);
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return json({ ok: false, error: 'invalid coordinate' }, 400);
    }
    points.push([lon, lat]);
    clean.push(`${lon.toFixed(6)},${lat.toFixed(6)}`);
  }

  let totalKm = 0;
  for (let index = 1; index < points.length; index += 1) {
    const legKm = haversineKm(points[index - 1][1], points[index - 1][0], points[index][1], points[index][0]);
    if (legKm > ROUTE_MAX_LEG_KM) return json({ ok: false, error: 'route leg too long' }, 400);
    totalKm += legKm;
  }
  if (totalKm > ROUTE_MAX_TOTAL_KM) return json({ ok: false, error: 'route too long' }, 400);

  const key = `${profile}|${clean.join(';')}`;
  const cached = routeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ROUTE_CACHE_MS) {
    return json(cached.payload, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600', 'X-World-Select-Route-Cache': 'HIT' });
  }

  let pending = routeInFlight.get(key);
  if (!pending) {
    pending = fetchRoute(profile, clean.join(';'));
    routeInFlight.set(key, pending);
    pending.finally(() => {
      if (routeInFlight.get(key) === pending) routeInFlight.delete(key);
    }).catch(() => undefined);
  }

  try {
    const payload = await pending;
    routeCache.set(key, { payload, cachedAt: Date.now() });
    while (routeCache.size > 200) routeCache.delete(routeCache.keys().next().value as string);
    return json(payload, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=600', 'X-World-Select-Route-Cache': 'MISS' });
  } catch (reason: any) {
    const message = reason?.name === 'AbortError' ? 'routing timeout' : reason instanceof Error ? reason.message : 'routing unavailable';
    const retryAfter = Number(reason?.retryAfter);
    if (message.includes('rate limited') || message.includes('routing busy')) {
      return json({ ok: false, error: message }, 429, { 'Retry-After': String(Number.isFinite(retryAfter) ? Math.max(1, retryAfter) : 5) });
    }
    return json({ ok: false, error: message }, 502);
  }
};
