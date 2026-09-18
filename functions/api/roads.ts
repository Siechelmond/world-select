type OverpassElement = {
  type: 'way' | 'node';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
  nodes?: number[];
};

type OverpassResponse = {
  elements: OverpassElement[];
};

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

const OVERPASS_TIMEOUT_S = 25;
const MAX_ELEMENTS = 50_000;

function bboxAround(lat: number, lon: number, radiusKm: number) {
  const deg = radiusKm / 111;
  return {
    south: lat - deg,
    west: lon - deg,
    north: lat + deg,
    east: lon + deg,
  };
}

function buildOverpassQuery(bbox: { south: number; west: number; north: number; east: number }) {
  const bb = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link)$"]${bb};
);
out geom ${MAX_ELEMENTS};
`;
}

function normalizeRoads(data: OverpassResponse): RoadSegment[] {
  const nodes = new Map<number, { lat: number; lon: number }>();
  for (const el of data.elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      nodes.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }
  const roads: RoadSegment[] = [];
  for (const el of data.elements) {
    if (el.type !== 'way') continue;
    const highway = el.tags?.highway ?? 'unclassified';
    if (!el.geometry?.length && !el.nodes?.length) continue;
    let coords: Array<[number, number]> = [];
    if (el.geometry?.length) {
      coords = el.geometry.map((p) => [p.lon, p.lat] as [number, number]);
    } else if (el.nodes?.length) {
      for (const nodeId of el.nodes) {
        const n = nodes.get(nodeId);
        if (n) coords.push([n.lon, n.lat]);
      }
    }
    if (coords.length < 2) continue;
    const maxspeedMatch = el.tags?.maxspeed?.match(/^(\d+)/);
    roads.push({
      id: el.id,
      coordinates: coords,
      highway,
      name: el.tags?.name ?? '',
      ref: el.tags?.ref ?? '',
      maxspeed: maxspeedMatch ? Number(maxspeedMatch[1]) : null,
      oneway: el.tags?.oneway === 'yes' || el.tags?.oneway === 'true',
      lanes: el.tags?.lanes ? Number(el.tags.lanes) : null,
    });
  }
  return roads;
}

export const onRequestGet = async (context: { request: Request }) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Math.min(15, Math.max(2, Number(url.searchParams.get('radius') ?? 8)));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: 'invalid coordinates' }, { status: 400 });
  }

  const bbox = bboxAround(lat, lon, radius);
  const query = buildOverpassQuery(bbox);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_S * 1000);

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return Response.json(
        { error: `Overpass returned HTTP ${response.status}`, roads: [] },
        { status: 502 },
      );
    }

    const data = await response.json() as OverpassResponse;
    const roads = normalizeRoads(data);

    return Response.json(
      { roads, count: roads.length, center: { lat, lon }, radius },
      {
        headers: {
          'Cache-Control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=300',
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : 'Overpass request failed';
    return Response.json(
      { error: message, roads: [] },
      { status: 502 },
    );
  }
};
