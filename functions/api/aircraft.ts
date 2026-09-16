export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Math.max(25, Math.min(250, Math.round(Number(url.searchParams.get("radius") || 250))));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }
  const upstream = await fetch(`https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radius}`, {
    headers: { "User-Agent": "WorldSelect/0.3.1" },
    cf: { cacheTtl: 8, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!upstream.ok) return Response.json({ error: `ADSB upstream HTTP ${upstream.status}` }, { status: 502 });
  return new Response(await upstream.text(), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=5, s-maxage=8" },
  });
};
