type Env = {
  TOMTOM_API_KEY?: string;
};

type TrafficProvider = 'orbis-v2' | 'classic-v4';

type TrafficFetchResult = {
  response: Response;
  provider: TrafficProvider;
};

let providerHint: TrafficProvider | null = null;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function orbisUrl(z: number, x: number, y: number, kind: 'flow' | 'incidents') {
  const path = kind === 'incidents' ? 'incidents/raster/tile' : 'flow/raster/tile';
  const upstream = new URL(`https://api.tomtom.com/maps/orbis/traffic/${path}/${z}/${x}/${y}`);
  upstream.searchParams.set('apiVersion', '2');
  upstream.searchParams.set('style', 'dark');
  upstream.searchParams.set('tileSize', '256');
  return upstream;
}

function classicUrl(apiKey: string, z: number, x: number, y: number, kind: 'flow' | 'incidents') {
  const style = kind === 'incidents' ? 's0-dark' : 'relative0-dark';
  const upstream = new URL(`https://api.tomtom.com/traffic/map/4/tile/${kind}/${style}/${z}/${x}/${y}.png`);
  upstream.searchParams.set('key', apiKey);
  upstream.searchParams.set('tileSize', '256');
  if (kind === 'incidents') upstream.searchParams.set('t', '-1');
  return upstream;
}

async function requestTomTom(url: URL, apiKey: string, provider: TrafficProvider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url.toString(), {
      headers: provider === 'orbis-v2'
        ? { 'TomTom-Api-Key': apiKey, 'TomTom-Api-Version': '2', Accept: 'image/png' }
        : { Accept: 'image/png' },
      signal: controller.signal,
      cf: { cacheTtl: 30, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTomTomTile(apiKey: string, z: number, x: number, y: number, kind: 'flow' | 'incidents' = 'flow'): Promise<TrafficFetchResult> {
  const order: TrafficProvider[] = providerHint === 'classic-v4'
    ? ['classic-v4', 'orbis-v2']
    : ['orbis-v2', 'classic-v4'];
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (const provider of order) {
    try {
      const response = await requestTomTom(
        provider === 'orbis-v2' ? orbisUrl(z, x, y, kind) : classicUrl(apiKey, z, x, y, kind),
        apiKey,
        provider,
      );
      lastResponse = response;
      if (response.ok) {
        providerHint = provider;
        return { response, provider };
      }
      // 401/403/404/596 can indicate that this API key/project is provisioned
      // for the other TomTom traffic family. Try the second documented endpoint
      // before declaring the layer unavailable.
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) return { response: lastResponse, provider: order[order.length - 1] };
  throw lastError ?? new Error('TomTom traffic upstream unavailable');
}

export const onRequestGet = async (context: { request: Request; env: Env }) => {
  const requestUrl = new URL(context.request.url);
  const mode = requestUrl.searchParams.get('mode');
  const apiKey = context.env?.TOMTOM_API_KEY;

  if (!apiKey) {
    if (mode === 'status') {
      return json({
        configured: false,
        available: false,
        provider: 'TomTom Traffic',
        message: 'TOMTOM_API_KEY not configured in this Cloudflare environment',
      });
    }
    return json({ error: 'traffic provider not configured in this Cloudflare environment' }, 503);
  }

  if (mode === 'status') {
    try {
      // Advisory probe only. The runtime attaches viewport tiles independently.
      const { response: probe, provider } = await fetchTomTomTile(apiKey, 0, 0, 0, 'flow');
      if (!probe.ok) {
        return json({
          configured: true,
          available: false,
          provider: provider === 'orbis-v2' ? 'TomTom Orbis Traffic v2' : 'TomTom Traffic Raster v4',
          upstreamStatus: probe.status,
          message: `TomTom rejected both traffic tile paths; last HTTP ${probe.status}`,
        });
      }
      return json({
        configured: true,
        available: true,
        provider: provider === 'orbis-v2' ? 'TomTom Orbis Traffic v2' : 'TomTom Traffic Raster v4',
        message: `live traffic flow available via ${provider}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Traffic probe failed';
      return json({
        configured: true,
        available: false,
        provider: 'TomTom Traffic',
        message,
      });
    }
  }

  const kind = requestUrl.searchParams.get('kind') === 'incidents' ? 'incidents' : 'flow';
  const z = Number(requestUrl.searchParams.get('z'));
  const x = Number(requestUrl.searchParams.get('x'));
  const y = Number(requestUrl.searchParams.get('y'));
  const maxTile = Number.isInteger(z) && z >= 0 && z <= 22 ? (2 ** z) - 1 : -1;

  if (
    ![z, x, y].every(Number.isInteger) ||
    z < 0 || z > 22 ||
    x < 0 || y < 0 ||
    x > maxTile || y > maxTile
  ) {
    return json({ error: 'invalid tile coordinates' }, 400);
  }

  try {
    const { response, provider } = await fetchTomTomTile(apiKey, z, x, y, kind);
    if (!response.ok) {
      return json({
        error: `TomTom traffic ${kind} request failed`,
        upstreamStatus: response.status,
        provider,
      }, 502);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'image/png',
        'Cache-Control': 'public, max-age=25, s-maxage=45, stale-while-revalidate=90',
        'X-World-Select-Source': provider === 'orbis-v2'
          ? (kind === 'incidents' ? 'TomTom Orbis Traffic Incidents v2' : 'TomTom Orbis Traffic Flow v2')
          : (kind === 'incidents' ? 'TomTom Traffic Incidents Raster v4' : 'TomTom Traffic Flow Raster v4'),
        'X-World-Select-Traffic-Provider': provider,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Traffic upstream error';
    return json({ error: message }, 502);
  }
};
