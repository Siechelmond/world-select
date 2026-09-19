const MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
];

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=600, s-maxage=2700, stale-while-revalidate=86400" },
  });
}

function clean(value: unknown, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export const onRequestGet = async () => {
  const params = new URLSearchParams({
    has_geo_info: "true",
    is_https: "true",
    hidebroken: "true",
    order: "clickcount",
    reverse: "true",
    limit: "600",
  });
  let rows: unknown[] | null = null;
  let lastStatus = 0;
  for (const origin of MIRRORS) {
    try {
      const response = await fetch(`${origin}/json/stations/search?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)" },
        cf: { cacheTtl: 2700, cacheEverything: true },
      } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
      lastStatus = response.status;
      if (!response.ok) continue;
      const payload = await response.json();
      if (Array.isArray(payload)) {
        rows = payload;
        break;
      }
    } catch {}
  }
  if (!rows) return json({ error: `Radio Browser unavailable${lastStatus ? ` (HTTP ${lastStatus})` : ""}`, items: [] }, 502);

  const now = new Date().toISOString();
  const items = rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const latitude = Number(row.geo_lat);
    const longitude = Number(row.geo_long);
    const id = clean(row.stationuuid, 64).toLowerCase();
    const streamUrl = clean(row.url_resolved || row.url, 500);
    if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !streamUrl.startsWith("https://")) return [];
    return [{
      id: `radio:${id}`,
      kind: "radio-station",
      name: clean(row.name, 120) || "Radio station",
      position: { longitude, latitude, altitudeMeters: 25 },
      observedAt: now,
      dataState: "OBSERVED",
      source: { id: "radio-browser", label: "Radio Browser", url: "https://www.radio-browser.info/" },
      properties: {
        stationUuid: id,
        streamUrl,
        homepage: clean(row.homepage, 500),
        country: clean(row.country, 80),
        language: clean(row.language, 80),
        tags: clean(row.tags, 300).toLowerCase(),
        codec: clean(row.codec, 24),
        bitrate: Number(row.bitrate ?? 0),
        clickCount: Number(row.clickcount ?? 0),
      },
    }];
  });
  return json({ items, count: items.length });
};
