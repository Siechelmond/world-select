type OverpassElement = {
  type: "way" | "node";
  id: number;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
  nodes?: number[];
};

type OverpassResponse = { elements: OverpassElement[] };

type RoadSegment = {
  id: number;
  coordinates: Array<[number, number]>;
  highway: string;
  name: string;
  ref: string;
  maxspeed: number | null;
  oneway: boolean;
  lanes: number | null;
};

const OVERPASS_TIMEOUT_MS = 6500;
const MAX_ELEMENTS = 30000;
const OVERPASS_UPSTREAMS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function bboxAround(lat: number, lon: number, radiusKm: number) {
  const latDeg = radiusKm / 111;
  const lonDeg = radiusKm / Math.max(20, 111 * Math.cos(lat * Math.PI / 180));
  return { south: lat - latDeg, west: lon - lonDeg, north: lat + latDeg, east: lon + lonDeg };
}

function buildOverpassQuery(bbox: { south: number; west: number; north: number; east: number }) {
  const bb = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:20];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link)$"]${bb};);out geom ${MAX_ELEMENTS};`;
}

function normalizeRoads(data: OverpassResponse): RoadSegment[] {
  const roads: RoadSegment[] = [];
  for (const el of data.elements ?? []) {
    if (el.type !== "way" || !el.geometry?.length) continue;
    const coords = el.geometry
      .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
      .map((point) => [point.lon, point.lat] as [number, number]);
    if (coords.length < 2) continue;
    const maxspeedMatch = el.tags?.maxspeed?.match(/^(\d+)/);
    roads.push({
      id: el.id,
      coordinates: coords,
      highway: el.tags?.highway ?? "unclassified",
      name: el.tags?.name ?? "",
      ref: el.tags?.ref ?? "",
      maxspeed: maxspeedMatch ? Number(maxspeedMatch[1]) : null,
      oneway: el.tags?.oneway === "yes" || el.tags?.oneway === "true",
      lanes: el.tags?.lanes ? Number(el.tags.lanes) : null,
    });
  }
  return roads;
}

async function fetchMirror(endpoint: string, body: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "WorldSelect/0.7 (+https://world-select.pages.dev)",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as OverpassResponse;
    if (!Array.isArray(data?.elements)) throw new Error("Malformed Overpass response");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Math.min(12, Math.max(2, Number(url.searchParams.get("radius") ?? 6)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Response.json({ error: "invalid coordinates", roads: [] }, { status: 400 });

  const query = buildOverpassQuery(bboxAround(lat, lon, radius));
  const body = `data=${encodeURIComponent(query)}`;
  let lastError = "Overpass unavailable";

  for (const endpoint of OVERPASS_UPSTREAMS) {
    try {
      const data = await fetchMirror(endpoint, body);
      const roads = normalizeRoads(data);
      return Response.json(
        { roads, count: roads.length, center: { lat, lon }, radius },
        { headers: {
          "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
          "X-World-Select-Source": endpoint,
        } },
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Overpass unavailable";
    }
  }

  return Response.json({ error: `All Overpass mirrors failed: ${lastError}`, roads: [] }, { status: 502 });
};
