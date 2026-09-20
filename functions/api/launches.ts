type LaunchLibraryResult = {
  id?: string;
  name?: string;
  net?: string;
  status?: { name?: string };
  launch_service_provider?: { name?: string };
  pad?: { name?: string; location?: { name?: string } };
};

export const onRequestGet = async () => {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '40');
  url.searchParams.set('mode', 'detailed');

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldSelect/0.7 (+https://world-select.pages.dev)' },
      cf: { cacheTtl: 900, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!upstream.ok) return Response.json({ error: `Launch Library HTTP ${upstream.status}` }, { status: 502 });
    const payload = await upstream.json() as { results?: LaunchLibraryResult[] };
    const results = (payload.results ?? []).slice(0, 40).map((item) => ({
      id: String(item.id ?? item.name ?? crypto.randomUUID()),
      name: String(item.name ?? 'Unnamed launch'),
      net: item.net ?? null,
      status: item.status?.name ?? null,
      provider: item.launch_service_provider?.name ?? null,
      pad: item.pad?.name ?? null,
      location: item.pad?.location?.name ?? null,
    }));
    return Response.json({ results, source: 'Launch Library 2', dataAsOf: end.toISOString() }, {
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=900' },
    });
  } catch {
    return Response.json({ error: 'Launch Library 2 unavailable' }, { status: 502 });
  }
};
