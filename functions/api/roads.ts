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
  bridge: boolean;
  tunnel: boolean;
  covered: boolean;
  layer: number | null;
};

const MAJOR_TIMEOUT_MS = 12_000;
const FULL_TIMEOUT_MS = 20_000;
const MAX_ELEMENTS = 30000;
const MAX_BBOX_SPAN_DEG = 0.05;
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

function buildOverpassQuery(
  bbox: { south: number; west: number; north: number; east: number },
  majorOnly: boolean,
) {
  const bb = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  const highwayRegex = majorOnly
    ? "^(motorway|trunk|primary|secondary)$"
    : "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link)$";
  const timeoutSec = majorOnly ? 12 : 20;
  return `[out:json][timeout:${timeoutSec}];(way["highway"~"${highwayRegex}"]${bb};);out geom qt ${MAX_ELEMENTS};`;
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
    const bridgeTag = String(el.tags?.bridge ?? "").toLowerCase();
    const tunnelTag = String(el.tags?.tunnel ?? "").toLowerCase();
    const coveredTag = String(el.tags?.covered ?? "").toLowerCase();
    const rawLayer = Number.parseFloat(String(el.tags?.layer ?? ""));
    roads.push({
      id: el.id,
      coordinates: coords,
      highway: el.tags?.highway ?? "unclassified",
      name: el.tags?.name ?? "",
      ref: el.tags?.ref ?? "",
      maxspeed: maxspeedMatch ? Number(maxspeedMatch[1]) : null,
      oneway: el.tags?.oneway === "yes" || el.tags?.oneway === "true",
      lanes: el.tags?.lanes ? Number(el.tags.lanes) : null,
      bridge: Boolean(bridgeTag && bridgeTag !== "no"),
      tunnel: Boolean(tunnelTag && tunnelTag !== "no"),
      covered: coveredTag === "yes" || coveredTag === "true",
      layer: Number.isFinite(rawLayer) ? rawLayer : null,
    });
  }
  return roads;
}

async function fetchMirror(endpoint: string, body: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  const majorOnly = url.searchParams.get("majorOnly") === "1";

  const south = Number(url.searchParams.get("south"));
  const west = Number(url.searchParams.get("west"));
  const north = Number(url.searchParams.get("north"));
  const east = Number(url.searchParams.get("east"));
  const hasBounds = [south, west, north, east].every(Number.isFinite);

  let bbox: { south: number; west: number; north: number; east: number };
  let responseMeta: Record<string, unknown>;

  if (hasBounds) {
    if (
      south < -90 || north > 90 || west < -180 || east > 180 ||
      north <= south || east <= west ||
      north - south > MAX_BBOX_SPAN_DEG + 1e-9 ||
      east - west > MAX_BBOX_SPAN_DEG + 1e-9
    ) {
      return Response.json({ error: "invalid or oversized bounds", roads: [] }, { status: 400 });
    }
    bbox = { south, west, north, east };
    responseMeta = { bounds: bbox, majorOnly };
  } else {
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const radius = Math.min(12, Math.max(2, Number(url.searchParams.get("radius") ?? 6)));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "invalid coordinates", roads: [] }, { status: 400 });
    }
    bbox = bboxAround(lat, lon, radius);
    responseMeta = { center: { lat, lon }, radius, majorOnly };
  }

  const query = buildOverpassQuery(bbox, majorOnly);
  const body = `data=${encodeURIComponent(query)}`;
  const timeoutMs = majorOnly ? MAJOR_TIMEOUT_MS : FULL_TIMEOUT_MS;
  let lastError = "Overpass unavailable";

  for (const endpoint of OVERPASS_UPSTREAMS) {
    try {
      const data = await fetchMirror(endpoint, body, timeoutMs);
      const resultRoads = normalizeRoads(data);
      return Response.json(
        { roads: resultRoads, count: resultRoads.length, ...responseMeta },
        { headers: {
          "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
          "X-World-Select-Source": endpoint,
          "X-World-Select-Road-Pass": majorOnly ? "major" : "full",
        } },
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Overpass unavailable";
    }
  }

  return Response.json({ error: `All Overpass mirrors failed: ${lastError}`, roads: [] }, { status: 502 });
};
