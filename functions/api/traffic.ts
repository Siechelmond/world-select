export const onRequestGet = async (context: any) => {
  const requestUrl = new URL(context.request.url);
  const mode = requestUrl.searchParams.get('mode');
  const apiKey = context.env?.TOMTOM_API_KEY as string | undefined;

  if (mode === 'status') {
    return Response.json({
      configured: Boolean(apiKey),
      provider: 'TomTom Traffic Flow',
      message: apiKey ? 'live traffic flow available' : 'TOMTOM_API_KEY not configured',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (!apiKey) {
    return Response.json({ error: 'traffic provider not configured' }, { status: 503 });
  }

  const z = Number(requestUrl.searchParams.get('z'));
  const x = Number(requestUrl.searchParams.get('x'));
  const y = Number(requestUrl.searchParams.get('y'));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0) {
    return Response.json({ error: 'invalid tile coordinates' }, { status: 400 });
  }

  const upstream = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(apiKey)}&tileSize=256`;
  const response = await fetch(upstream, {
    cf: { cacheTtl: 30, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

  if (!response.ok) {
    return Response.json({ error: `TomTom traffic HTTP ${response.status}` }, { status: 502 });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'image/png',
      'Cache-Control': 'public, max-age=20, s-maxage=30',
      'X-World-Select-Source': 'TomTom Traffic Flow',
    },
  });
};
