type Env = {
  TOMTOM_API_KEY?: string;
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

async function fetchTomTomTile(apiKey: string, z: number, x: number, y: number, kind: 'flow' | 'incidents' = 'flow') {
  const path = kind === 'incidents' ? 'incidents/raster/tile' : 'flow/raster/tile';
  const upstream = new URL(`https://api.tomtom.com/maps/orbis/traffic/${path}/${z}/${x}/${y}`);
  upstream.searchParams.set('apiVersion', '2');
  upstream.searchParams.set('style', 'dark');
  if (kind === 'flow') upstream.searchParams.set('tileSize', '256');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(upstream.toString(), {
      headers: {
        'TomTom-Api-Key': apiKey,
        Accept: 'image/png',
      },
      signal: controller.signal,
      cf: { cacheTtl: 30, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  } finally {
    clearTimeout(timeout);
  }
}


async function fetchTomTomVectorTile(apiKey: string, z: number, x: number, y: number) {
  const upstream = new URL('https://api.tomtom.com/traffic/map/4/tile/flow/relative/' + z + '/' + x + '/' + y + '.pbf');
  upstream.searchParams.set('key', apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(upstream.toString(), {
      headers: { Accept: 'application/x-protobuf' },
      signal: controller.signal,
      cf: { cacheTtl: 90, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  } finally {
    clearTimeout(timeout);
  }
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
        provider: 'TomTom Orbis Traffic Flow v2',
        message: 'TOMTOM_API_KEY not configured',
      });
    }
    return json({ error: 'traffic provider not configured' }, 503);
  }

  if (mode === 'vector') {
    const z = Number(requestUrl.searchParams.get('z'));
    const x = Number(requestUrl.searchParams.get('x'));
    const y = Number(requestUrl.searchParams.get('y'));
    const maxTile = Number.isInteger(z) && z >= 8 && z <= 16 ? (2 ** z) - 1 : -1;
    if (
      ![z, x, y].every(Number.isInteger) ||
      z < 8 || z > 16 ||
      x < 0 || y < 0 ||
      x > maxTile || y > maxTile
    ) {
      return json({ error: 'invalid vector tile coordinates' }, 400);
    }
    try {
      const response = await fetchTomTomVectorTile(apiKey, z, x, y);
      if (!response.ok) {
        return json({ error: 'TomTom vector flow unavailable', upstreamStatus: response.status }, 502);
      }
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'application/x-protobuf',
          'Cache-Control': 'public, max-age=60, s-maxage=90, stale-while-revalidate=180',
          'X-World-Select-Source': 'TomTom Traffic Flow vector tile',
        },
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'TomTom vector upstream error' }, 502);
    }
  }

  if (mode === 'status') {
    try {
      // One low-cost probe tile verifies that the deployed secret is actually accepted.
      const probe = await fetchTomTomTile(apiKey, 0, 0, 0, 'flow');
      if (!probe.ok) {
        return json({
          configured: true,
          available: false,
          provider: 'TomTom Orbis Traffic Flow v2',
          upstreamStatus: probe.status,
          message: `TomTom rejected the traffic request (HTTP ${probe.status})`,
        });
      }
      return json({
        configured: true,
        available: true,
        provider: 'TomTom Orbis Traffic Flow v2',
        message: 'live traffic flow available',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Traffic probe failed';
      return json({
        configured: true,
        available: false,
        provider: 'TomTom Orbis Traffic Flow v2',
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
    const response = await fetchTomTomTile(apiKey, z, x, y, kind);
    if (!response.ok) {
      return json({
        error: `TomTom traffic ${kind} request failed`,
        upstreamStatus: response.status,
      }, 502);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'image/png',
        'Cache-Control': 'public, max-age=25, s-maxage=45, stale-while-revalidate=90',
        'X-World-Select-Source': kind === 'incidents' ? 'TomTom Orbis Traffic Incidents v2' : 'TomTom Orbis Traffic Flow v2',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Traffic upstream error';
    return json({ error: message }, 502);
  }
};
