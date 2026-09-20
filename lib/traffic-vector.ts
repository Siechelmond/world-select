export type RoadSegment = {
  id: number;
  coordinates: Array<[number, number]>;
  highway: string;
  name: string;
  ref: string;
  maxspeed: number | null;
  oneway: boolean;
  lanes: number | null;
};

export type FlowSegment = {
  roadId: number;
  congestion: 'free-flow' | 'light' | 'heavy' | 'jam';
  currentSpeedKmh: number;
  freeFlowSpeedKmh: number;
  delaySeconds: number;
};

export type ModeledVehicle = {
  id: string;
  roadId: number;
  segmentIndex: number;
  progress: number;
  speedKmh: number;
  headingDeg: number;
  position: { latitude: number; longitude: number };
  congestion: FlowSegment['congestion'];
};

export type TrafficVectorSnapshot = {
  roads: RoadSegment[];
  flows: FlowSegment[];
  vehicles: ModeledVehicle[];
  source: 'overpass' | 'overpass+tomtom-vector';
  fetchedAt: number;
};

const CONGESTION_COLORS: Record<FlowSegment['congestion'], string> = {
  'free-flow': '#22c55e',
  'light': '#eab308',
  'heavy': '#f97316',
  'jam': '#ef4444',
};

const VEHICLE_BUDGET = 400;
const MIN_ROAD_LENGTH_M = 30;

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinLon * sinLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const toDeg = (r: number) => r * 180 / Math.PI;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

type RoadMetrics = {
  totalLengthM: number;
  segmentLengthsM: number[];
  segmentHeadingsDeg: number[];
};

const ROAD_METRICS_CACHE = new WeakMap<Array<[number, number]>, RoadMetrics>();
const ROAD_BY_ID_CACHE = new WeakMap<RoadSegment[], Map<number, RoadSegment>>();
const FLOW_BY_ROAD_CACHE = new WeakMap<FlowSegment[], Map<number, FlowSegment>>();

function roadById(roads: RoadSegment[]) {
  const cached = ROAD_BY_ID_CACHE.get(roads);
  if (cached) return cached;
  const map = new Map(roads.map((road) => [road.id, road]));
  ROAD_BY_ID_CACHE.set(roads, map);
  return map;
}

function flowByRoad(flows: FlowSegment[]) {
  const cached = FLOW_BY_ROAD_CACHE.get(flows);
  if (cached) return cached;
  const map = new Map(flows.map((flow) => [flow.roadId, flow]));
  FLOW_BY_ROAD_CACHE.set(flows, map);
  return map;
}

function roadMetrics(coords: Array<[number, number]>): RoadMetrics {
  const cached = ROAD_METRICS_CACHE.get(coords);
  if (cached) return cached;

  const segmentLengthsM: number[] = [];
  const segmentHeadingsDeg: number[] = [];
  let totalLengthM = 0;
  for (let i = 1; i < coords.length; i++) {
    const lengthM = haversineM(coords[i - 1], coords[i]);
    segmentLengthsM.push(lengthM);
    segmentHeadingsDeg.push(bearingDeg(coords[i - 1], coords[i]));
    totalLengthM += lengthM;
  }
  const metrics = { totalLengthM, segmentLengthsM, segmentHeadingsDeg };
  ROAD_METRICS_CACHE.set(coords, metrics);
  return metrics;
}

function totalRoadLength(coords: Array<[number, number]>): number {
  return roadMetrics(coords).totalLengthM;
}

function interpolateAlongRoad(
  coords: Array<[number, number]>,
  progress: number,
): { position: [number, number]; heading: number; segmentIndex: number } {
  const metrics = roadMetrics(coords);
  const target = metrics.totalLengthM * progress;
  let traveled = 0;
  for (let i = 1; i < coords.length; i++) {
    const segLen = metrics.segmentLengthsM[i - 1] ?? 0;
    if (traveled + segLen >= target) {
      const frac = segLen > 0 ? (target - traveled) / segLen : 0;
      const lon = coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * frac;
      const lat = coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * frac;
      return {
        position: [lon, lat],
        heading: metrics.segmentHeadingsDeg[i - 1] ?? 0,
        segmentIndex: i - 1,
      };
    }
    traveled += segLen;
  }
  const last = coords[coords.length - 1];
  const segmentIndex = Math.max(0, coords.length - 2);
  return {
    position: last,
    heading: metrics.segmentHeadingsDeg[segmentIndex] ?? 0,
    segmentIndex,
  };
}

function inferFreeFlowSpeed(road: RoadSegment): number {
  if (road.maxspeed) return road.maxspeed;
  const limits: Record<string, number> = {
    motorway: 120, trunk: 100, primary: 80, secondary: 70,
    tertiary: 50, unclassified: 50, residential: 30,
    motorway_link: 60, trunk_link: 50, primary_link: 50, secondary_link: 40,
  };
  return limits[road.highway] ?? 50;
}

function classifyCongestion(ratio: number): FlowSegment['congestion'] {
  if (ratio >= 0.85) return 'free-flow';
  if (ratio >= 0.6) return 'light';
  if (ratio >= 0.3) return 'heavy';
  return 'jam';
}

function validLonLat(value: [number, number]) {
  const [lon, lat] = value;
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

function stableUnit(value: number) {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export async function fetchRoads(
  lat: number,
  lon: number,
  radiusKm = 8,
  signal?: AbortSignal,
): Promise<RoadSegment[]> {
  const url = `/api/roads?lat=${lat}&lon=${lon}&radius=${radiusKm}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Roads endpoint returned HTTP ${response.status}`);
  const data = await response.json() as { roads: RoadSegment[] };
  return (data.roads ?? [])
    .map((road) => ({
      ...road,
      coordinates: road.coordinates.filter(validLonLat),
    }))
    .filter((road) => road.coordinates.length >= 2);
}

export function buildModeledFlows(roads: RoadSegment[]): FlowSegment[] {
  return roads.map((road) => {
    const freeFlow = inferFreeFlowSpeed(road);
    const variance = 0.7 + stableUnit(road.id) * 0.35;
    const current = Math.round(freeFlow * variance);
    const ratio = current / freeFlow;
    return {
      roadId: road.id,
      congestion: classifyCongestion(ratio),
      currentSpeedKmh: current,
      freeFlowSpeedKmh: freeFlow,
      delaySeconds: 0,
    };
  });
}

export function generateModeledVehicles(
  roads: RoadSegment[],
  flows: FlowSegment[],
  budget = VEHICLE_BUDGET,
): ModeledVehicle[] {
  const eligible = roads.filter((r) => totalRoadLength(r.coordinates) >= MIN_ROAD_LENGTH_M);
  if (!eligible.length) return [];
  const vehicles: ModeledVehicle[] = [];
  const flowMap = new Map(flows.map((f) => [f.roadId, f]));
  const perRoad = Math.max(1, Math.ceil(budget / eligible.length));

  for (const road of eligible) {
    if (vehicles.length >= budget) break;
    const flow = flowMap.get(road.id);
    const speed = flow?.currentSpeedKmh ?? 50;
    const count = Math.min(perRoad, budget - vehicles.length);
    for (let i = 0; i < count; i++) {
      const progress = (i + stableUnit(road.id * 997 + i * 37)) / count;
      const { position, heading, segmentIndex } = interpolateAlongRoad(road.coordinates, progress);
      vehicles.push({
        id: `veh-${road.id}-${i}`,
        roadId: road.id,
        segmentIndex,
        progress,
        speedKmh: speed,
        headingDeg: heading,
        position: { latitude: position[1], longitude: position[0] },
        congestion: flow?.congestion ?? 'free-flow',
      });
    }
  }
  return vehicles;
}

export function advanceModeledVehicles(
  vehicles: ModeledVehicle[],
  roads: RoadSegment[],
  flows: FlowSegment[],
  deltaSeconds: number,
): ModeledVehicle[] {
  const roadMap = roadById(roads);
  const flowMap = flowByRoad(flows);

  // This is a render hot path. Reuse the vehicle records and nested position
  // objects instead of allocating a replacement fleet on every animation tick.
  for (const vehicle of vehicles) {
    const road = roadMap.get(vehicle.roadId);
    if (!road) continue;

    const flow = flowMap.get(vehicle.roadId);
    const speedKmh = flow?.currentSpeedKmh ?? vehicle.speedKmh ?? 50;
    const roadLength = totalRoadLength(road.coordinates);
    if (roadLength <= 0) continue;

    let progress = vehicle.progress + ((speedKmh / 3.6) * deltaSeconds) / roadLength;
    if (progress > 1) progress -= Math.floor(progress);

    const next = interpolateAlongRoad(road.coordinates, progress);
    vehicle.progress = progress;
    vehicle.position.longitude = next.position[0];
    vehicle.position.latitude = next.position[1];
    vehicle.headingDeg = next.heading;
    vehicle.segmentIndex = next.segmentIndex;
    vehicle.speedKmh = speedKmh;
    vehicle.congestion = flow?.congestion ?? vehicle.congestion;
  }
  return vehicles;
}

export function getCongestionColor(congestion: FlowSegment['congestion']): string {
  return CONGESTION_COLORS[congestion];
}

export function isVectorTrafficAvailable(): boolean {
  return true;
}

export const TOMTOM_VECTOR_FLOW_BLOCKER =
  'TomTom vector flow (MVT) requires a TOMTOM_API_KEY provisioned for the ' +
  'Orbis Flow Vector Tiles product. The existing key (if any) is not ' +
  'confirmed to support this endpoint. Raster traffic remains as fallback.';
