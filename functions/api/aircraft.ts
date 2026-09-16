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

async function fetchJson(url: string, userAgent: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    cf: { cacheTtl: 8, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

async function adsbLol(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radius}`, 'WorldSelect/0.4');
  return { ac: Array.isArray(payload?.ac) ? payload.ac : [], now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? payload?.ac?.length ?? 0), provider: 'adsb.lol' };
}

async function airplanesLive(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radius}`, 'WorldSelect/0.4');
  return { ac: Array.isArray(payload?.ac) ? payload.ac : [], now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? payload?.ac?.length ?? 0), provider: 'airplanes.live' };
}

async function adsbFi(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const payload = await fetchJson(`https://opendata.adsb.fi/api/v3/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radius}`, 'WorldSelect/0.4');
  const ac = Array.isArray(payload?.ac) ? payload.ac : Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  return { ac, now: Number(payload?.now ?? Date.now()), total: Number(payload?.total ?? ac.length), provider: 'adsb.fi' };
}

async function openSky(lat: number, lon: number, radius: number): Promise<ProviderResult> {
  const box = bboxForRadius(lat, lon, radius);
  const url = new URL('https://opensky-network.org/api/states/all');
  url.searchParams.set('lamin', box.lamin.toFixed(4));
  url.searchParams.set('lamax', box.lamax.toFixed(4));
  url.searchParams.set('lomin', box.lomin.toFixed(4));
  url.searchParams.set('lomax', box.lomax.toFixed(4));
  const payload = await fetchJson(url.toString(), 'WorldSelect/0.4');
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

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Math.max(25, Math.min(250, Math.round(Number(url.searchParams.get('radius') ?? 220))));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: 'invalid coordinates' }, { status: 400 });
  }

  const providers = [adsbLol, airplanesLive, adsbFi, openSky];
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const payload = await provider(lat, lon, radius);
      if (payload.ac.length || provider === providers[providers.length - 1]) {
        return Response.json(payload, {
          headers: {
            'Cache-Control': 'public, max-age=5, s-maxage=8',
            'X-World-Select-Aircraft-Provider': payload.provider,
          },
        });
      }
      failures.push(`${payload.provider}: empty`);
    } catch (error: any) {
      failures.push(`${provider.name}: ${String(error?.message ?? error)}`);
    }
  }

  return Response.json({ error: 'aircraft providers unavailable', failures }, { status: 502 });
};
