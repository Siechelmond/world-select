type NominatimRow = {
  place_id?: number | string;
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  boundingbox?: [string, string, string, string];
  address?: { house_number?: string; road?: string; pedestrian?: string; city?: string; town?: string; village?: string };
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" },
  });
}

function parseCoordinates(query: string) {
  const match = query.trim().match(/^\s*([+-]?\d+(?:\.\d+)?)\s*[,;]\s*([+-]?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function heightFor(row: NominatimRow) {
  const type = String(row.type ?? "").toLowerCase();

  // Place type wins over Nominatim's administrative bounding box. Large city
  // boxes (Berlin/San Francisco) were previously converted into hundreds of
  // kilometres of camera height, which made a correct result look "off".
  if (/(house|building|address)/.test(type)) return 5_000;
  if (/suburb|neighbourhood|quarter/.test(type)) return 14_000;
  if (/village|hamlet/.test(type)) return 20_000;
  if (/town/.test(type)) return 32_000;
  if (/city|municipality/.test(type)) return 55_000;
  if (/(state|region|province)/.test(type)) return 450_000;
  if (/country/.test(type)) return 1_500_000;

  const box = row.boundingbox?.map(Number);
  if (box?.length === 4 && box.every(Number.isFinite)) {
    const latSpan = Math.abs(box[1] - box[0]);
    const lonSpan = Math.abs(box[3] - box[2]);
    return Math.min(900_000, Math.max(10_000, Math.max(latSpan, lonSpan) * 111_000 * 1.5));
  }
  return 180_000;
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, 180);
  if (!query) return json({ results: [] });

  const coordinate = parseCoordinates(query);
  if (coordinate) {
    return json({ results: [{
      id: `coord:${coordinate.latitude.toFixed(6)}:${coordinate.longitude.toFixed(6)}`,
      label: `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      kind: "coordinates",
      heightMeters: 50_000,
    }] });
  }

  const upstream = new URL("https://nominatim.openstreetmap.org/search");
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("format", "jsonv2");
  upstream.searchParams.set("limit", "5");
  upstream.searchParams.set("addressdetails", "1");

  try {
    const response = await fetch(upstream.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en",
        "User-Agent": "WorldSelect/0.7 (+https://world-select.pages.dev)",
      },
      cf: { cacheTtl: 900, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!response.ok) return json({ error: `Nominatim returned HTTP ${response.status}`, results: [] }, 502);
    const rows = await response.json() as NominatimRow[];
    const addressLike = /\d/.test(query);
    const rankedRows = (Array.isArray(rows) ? rows : [])
      .map((row, index) => {
        const type = String(row.type ?? "").toLowerCase();
        const address = row.address ?? {};
        const score = (addressLike && address.house_number ? 100 : 0)
          + (/(house|building|address)/.test(type) ? 60 : 0)
          + ((address.road || address.pedestrian) ? 25 : 0)
          - index;
        return { row, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ row }) => row);
    const results = rankedRows.flatMap((row) => {
      const latitude = Number(row.lat);
      const longitude = Number(row.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
      return [{
        id: String(row.place_id ?? `${latitude}:${longitude}`),
        label: String(row.display_name ?? query),
        latitude,
        longitude,
        kind: String(row.type ?? row.class ?? "place"),
        heightMeters: heightFor(row),
      }];
    });
    return json({ results });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Place search unavailable", results: [] }, 502);
  }
};
