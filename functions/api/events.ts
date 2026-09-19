type EonetGeometry = {
  date?: string;
  type?: "Point" | "Polygon";
  coordinates?: unknown;
  magnitudeValue?: number | null;
  magnitudeUnit?: string | null;
};

type EonetEvent = {
  id?: string;
  title?: string;
  link?: string;
  categories?: Array<{ id?: string; title?: string }>;
  sources?: Array<{ id?: string; url?: string }>;
  geometry?: EonetGeometry[];
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=900" },
  });
}

function centroidPolygon(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null;
  const ring = value[0] as unknown[];
  const points = ring
    .filter((point): point is [number, number] =>
      Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [Number(point[0]), Number(point[1])] as [number, number]);
  if (!points.length) return null;
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]] as [number, number], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function position(geometry: EonetGeometry): [number, number] | null {
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates as unknown[];
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [Number(lon), Number(lat)];
  }
  if (geometry.type === "Polygon") return centroidPolygon(geometry.coordinates);
  return null;
}

function filterCategory(id = "", title = "") {
  const key = `${id} ${title}`.toLowerCase();
  if (key.includes("wildfire") || key.includes("fire")) return "fire";
  if (key.includes("storm") || key.includes("cyclone")) return "storm";
  if (key.includes("volcano")) return "volcano";
  if (key.includes("flood")) return "flood";
  if (key.includes("ice") || key.includes("snow")) return "ice";
  return "other";
}

export const onRequestGet = async () => {
  try {
    const upstream = await fetch("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=45&limit=250", {
      headers: { Accept: "application/json", "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)" },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!upstream.ok) return json({ error: `NASA EONET returned HTTP ${upstream.status}`, items: [] }, 502);
    const payload = await upstream.json() as { events?: EonetEvent[] };
    const items = (payload.events ?? []).flatMap((event) => {
      const geometry = [...(event.geometry ?? [])].reverse().find((entry) => position(entry));
      if (!geometry) return [];
      const point = position(geometry);
      if (!point) return [];
      const category = event.categories?.[0] ?? {};
      const source = event.sources?.[0];
      const observedAt = geometry.date && !Number.isNaN(Date.parse(geometry.date))
        ? new Date(geometry.date).toISOString()
        : new Date().toISOString();
      return [{
        id: `eonet:${event.id ?? event.title ?? point.join(":")}`,
        kind: "natural-event",
        name: event.title ?? "NASA EONET event",
        position: { longitude: point[0], latitude: point[1], altitudeMeters: 0 },
        observedAt,
        dataState: "OBSERVED",
        source: {
          id: "nasa-eonet",
          label: "NASA EONET",
          url: source?.url ?? event.link ?? "https://eonet.gsfc.nasa.gov/",
        },
        properties: {
          category: filterCategory(category.id, category.title),
          categoryId: category.id ?? "other",
          categoryTitle: category.title ?? "Other",
          magnitude: geometry.magnitudeValue ?? null,
          magnitudeUnit: geometry.magnitudeUnit ?? null,
        },
      }];
    });
    return json({ items, count: items.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "NASA EONET unavailable", items: [] }, 502);
  }
};
