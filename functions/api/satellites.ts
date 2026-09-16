const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=TLE";

export const onRequestGet = async () => {
  const upstream = await fetch(CELESTRAK, {
    headers: { "User-Agent": "WorldSelect/0.3.1 (+https://world-select.pages.dev)" },
    cf: { cacheTtl: 7200, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!upstream.ok) return new Response(`CelesTrak upstream HTTP ${upstream.status}`, { status: 502 });
  return new Response(await upstream.text(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=7200",
    },
  });
};
