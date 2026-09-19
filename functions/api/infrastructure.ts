type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

type InfrastructureCategory = "cable" | "landing" | "datacenter" | "dam";

type InfrastructureFeature = {
  id: string;
  category: InfrastructureCategory;
  name: string;
  operator: string;
  point?: { longitude: number; latitude: number };
  coordinates?: Array<[number, number]>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" },
  });
}

function bboxAround(lat: number, lon: number, radiusKm: number) {
  const latDeg = radiusKm / 111;
  const lonDeg = radiusKm / Math.max(20, 111 * Math.cos(lat * Math.PI / 180));
  return { south: lat - latDeg, west: lon - lonDeg, north: lat + latDeg, east: lon + lonDeg };
}

function category(el: OverpassElement): InfrastructureCategory | null {
  const tags = el.tags ?? {};
  if (tags.communication === "line" && (tags.submarine === "yes" || tags.location === "underwater" || tags["seamark:type"] === "cable_submarine")) return "cable";
  if (tags.telecom === "cable_landing_station") return "landing";
  if (tags.telecom === "data_center") return "datacenter";
  if (tags.waterway === "dam" || tags.man_made === "dam") return "dam";
  return null;
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Math.min(250, Math.max(5, Number(url.searchParams.get("radius") ?? 50)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "invalid coordinates", features: [] }, 400);
  const bbox = bboxAround(lat, lon, radius);
  const bb = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  const query = `[out:json][timeout:25];
(
  way["communication"="line"]["submarine"="yes"]${bb};
  way["communication"="line"]["location"="underwater"]${bb};
  way["seamark:type"="cable_submarine"]${bb};
  nwr["telecom"="cable_landing_station"]${bb};
  nwr["telecom"="data_center"]${bb};
  nwr["waterway"="dam"]${bb};
  nwr["man_made"="dam"]${bb};
);
out center geom 12000;`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
      cf: { cacheTtl: 900, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!response.ok) return json({ error: `Overpass returned HTTP ${response.status}`, features: [] }, 502);

    const payload = await response.json() as { elements?: OverpassElement[] };
    const seen = new Set<string>();
    const features = (payload.elements ?? []).reduce<InfrastructureFeature[]>((out, el) => {
      const cat = category(el);
      if (!cat) return out;

      const id = `osm:${el.type}:${el.id}`;
      if (seen.has(id)) return out;
      seen.add(id);

      const tags = el.tags ?? {};
      const name = tags.name || tags.ref || (
        cat === "cable"
          ? "Submarine telecom cable"
          : cat === "landing"
            ? "Cable landing station"
            : cat === "datacenter"
              ? "Data center"
              : "Dam"
      );

      if (cat === "cable") {
        const coordinates = (el.geometry ?? [])
          .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
          .map((point) => [point.lon, point.lat] as [number, number]);

        if (coordinates.length >= 2) {
          out.push({ id, category: cat, name, operator: tags.operator ?? "", coordinates });
        }
        return out;
      }

      const point = el.type === "node"
        ? { longitude: Number(el.lon), latitude: Number(el.lat) }
        : { longitude: Number(el.center?.lon), latitude: Number(el.center?.lat) };

      if ([point.longitude, point.latitude].every(Number.isFinite)) {
        out.push({ id, category: cat, name, operator: tags.operator ?? "", point });
      }
      return out;
    }, []);

    return json({ features, count: features.length, center: { lat, lon }, radius });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Overpass unavailable", features: [] }, 502);
  } finally {
    clearTimeout(timeout);
  }
};
