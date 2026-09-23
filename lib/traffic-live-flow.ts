import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import {
  inferFreeFlowSpeed,
  type FlowSegment,
  type RoadSegment,
} from '@/lib/traffic-vector';

type FlowPolyline = {
  coords: Array<[number, number]>;
  trafficLevel: number;
  roadType: string;
  closure: boolean;
  leftHandTraffic: boolean | null;
  partOfTwoWayRoad: boolean | null;
};

const FLOW_LAYER_NAME = 'Traffic flow';
const TILE_ZOOM = 12;
const M_PER_DEG_LAT = 111320;
const CELL_SIZE_M = 100;
const MATCH_RADIUS_M = 35;
const BEARING_TOLERANCE_DEG = 30;
const ROAD_SAMPLES = 7;
const MIN_MATCHED_SAMPLES = 2;
const MERCATOR_LAT_LIMIT = 85.05112878;

function optionalBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const latRad = clampedLat * Math.PI / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function tilesForBounds(
  bounds: { south: number; west: number; north: number; east: number },
  zoom = TILE_ZOOM,
  maxTiles = 16,
) {
  const nw = lonLatToTile(Math.min(bounds.west, bounds.east), Math.max(bounds.south, bounds.north), zoom);
  const se = lonLatToTile(Math.max(bounds.west, bounds.east), Math.min(bounds.south, bounds.north), zoom);
  const tiles: Array<{ z: number; x: number; y: number }> = [];
  for (let y = nw.y; y <= se.y; y += 1) {
    for (let x = nw.x; x <= se.x; x += 1) {
      if (tiles.length >= maxTiles) return tiles;
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

function decodeFlowTile(data: ArrayBuffer, z: number, x: number, y: number): FlowPolyline[] {
  let layer: any;
  try {
    const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    return [];
  }
  if (!layer) return [];

  const segments: FlowPolyline[] = [];
  for (let index = 0; index < layer.length; index += 1) {
    try {
      const feature = layer.feature(index);
      const geometry = feature.toGeoJSON(x, y, z).geometry as any;
      const props = feature.properties ?? {};
      const closure = props.road_closure === true || props.road_closure === 'true';
      const rawLevel = typeof props.relative_speed === 'number'
        ? props.relative_speed
        : props.traffic_level;
      const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
      if (!hasLevel && !closure) continue;
      const trafficLevel = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
      const roadType = typeof props.road_category === 'string'
        ? props.road_category
        : typeof props.road_type === 'string'
          ? props.road_type
          : '';
      const lines = geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
      for (const coords of lines) {
        if (!Array.isArray(coords) || coords.length < 2) continue;
        segments.push({
          coords: coords.map((value: number[]) => [Number(value[0]), Number(value[1])] as [number, number]),
          trafficLevel,
          roadType,
          closure,
          leftHandTraffic: optionalBoolean(props.left_hand_traffic),
          partOfTwoWayRoad: optionalBoolean(props.part_of_two_way_road),
        });
      }
    } catch {
      // One malformed feature must not drop the tile.
    }
  }
  return segments;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bearingDeg(dx: number, dy: number) {
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

function directedBearingDiffDeg(a: number, b: number) {
  let delta = Math.abs(a - b) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

type DirectionalFlowMatch = {
  level: number;
  closure: boolean;
  leftHandTraffic?: boolean;
  partOfTwoWayRoad?: boolean;
};

function matchFlowToRoads(roads: RoadSegment[], flowSegments: FlowPolyline[]) {
  const matches: Array<{ forward?: DirectionalFlowMatch; reverse?: DirectionalFlowMatch } | null> = new Array(roads.length).fill(null);
  if (!roads.length || !flowSegments.length) return { matches, matchedCount: 0, candidateCount: 0 };

  const anchor = flowSegments.find((flow) => flow.coords.length >= 2);
  if (!anchor) return { matches, matchedCount: 0, candidateCount: 0 };

  const [refLon, refLat] = anchor.coords[0];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(refLat * Math.PI / 180);
  const projX = (lon: number) => (lon - refLon) * mPerDegLon;
  const projY = (lat: number) => (lat - refLat) * M_PER_DEG_LAT;
  const cellOf = (x: number, y: number) => Math.floor(x / CELL_SIZE_M) + ',' + Math.floor(y / CELL_SIZE_M);

  type GridSegment = {
    ax: number; ay: number; bx: number; by: number;
    bearing: number; level: number; closure: boolean;
    leftHandTraffic: boolean | null;
    partOfTwoWayRoad: boolean | null;
  };
  const grid = new Map<string, GridSegment[]>();

  for (const flow of flowSegments) {
    for (let i = 0; i < flow.coords.length - 1; i += 1) {
      const ax = projX(flow.coords[i][0]);
      const ay = projY(flow.coords[i][1]);
      const bx = projX(flow.coords[i + 1][0]);
      const by = projY(flow.coords[i + 1][1]);
      const segLen = Math.hypot(bx - ax, by - ay);
      if (!(segLen > 0)) continue;
      const bearing = bearingDeg(bx - ax, by - ay);
      const pieces = Math.max(1, Math.ceil(segLen / CELL_SIZE_M));
      for (let p = 0; p < pieces; p += 1) {
        const t0 = p / pieces;
        const t1 = (p + 1) / pieces;
        const segment: GridSegment = {
          ax: ax + (bx - ax) * t0,
          ay: ay + (by - ay) * t0,
          bx: ax + (bx - ax) * t1,
          by: ay + (by - ay) * t1,
          bearing,
          level: flow.trafficLevel,
          closure: flow.closure,
          leftHandTraffic: flow.leftHandTraffic,
          partOfTwoWayRoad: flow.partOfTwoWayRoad,
        };
        const key = cellOf((segment.ax + segment.bx) / 2, (segment.ay + segment.by) / 2);
        const bucket = grid.get(key) ?? [];
        bucket.push(segment);
        grid.set(key, bucket);
      }
    }
  }

  const radius2 = MATCH_RADIUS_M ** 2;
  let matchedCount = 0;
  let candidateCount = 0;

  for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
    const coords = roads[roadIndex].coordinates;
    if (coords.length < 2) continue;
    const xs = new Array<number>(coords.length);
    const ys = new Array<number>(coords.length);
    const cumulative = new Array<number>(coords.length);
    cumulative[0] = 0;
    for (let i = 0; i < coords.length; i += 1) {
      xs[i] = projX(coords[i][0]);
      ys[i] = projY(coords[i][1]);
      if (i > 0) cumulative[i] = cumulative[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    const totalLength = cumulative[coords.length - 1];
    if (!(totalLength > 0)) continue;

    let hadCandidate = false;
    const forwardLevels: number[] = [];
    const reverseLevels: number[] = [];
    let forwardClosure = false;
    let reverseClosure = false;
    const forwardMeta: GridSegment[] = [];
    const reverseMeta: GridSegment[] = [];
    let cursor = 1;

    for (let sample = 0; sample < ROAD_SAMPLES; sample += 1) {
      const target = totalLength * (sample + 0.5) / ROAD_SAMPLES;
      while (cursor < coords.length - 1 && cumulative[cursor] < target) cursor += 1;
      const denom = cumulative[cursor] - cumulative[cursor - 1] || 1;
      const segmentT = (target - cumulative[cursor - 1]) / denom;
      const px = xs[cursor - 1] + (xs[cursor] - xs[cursor - 1]) * segmentT;
      const py = ys[cursor - 1] + (ys[cursor] - ys[cursor - 1]) * segmentT;
      const sampleBearing = bearingDeg(xs[cursor] - xs[cursor - 1], ys[cursor] - ys[cursor - 1]);
      const cx = Math.floor(px / CELL_SIZE_M);
      const cy = Math.floor(py / CELL_SIZE_M);
      let bestForward: GridSegment | null = null;
      let bestReverse: GridSegment | null = null;
      let bestForwardDist2 = radius2;
      let bestReverseDist2 = radius2;

      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
          const bucket = grid.get(gx + ',' + gy);
          if (!bucket) continue;
          for (const segment of bucket) {
            const distance2 = pointSegDist2(px, py, segment.ax, segment.ay, segment.bx, segment.by);
            if (distance2 > radius2) continue;
            hadCandidate = true;
            const bearingDelta = directedBearingDiffDeg(segment.bearing, sampleBearing);
            if (bearingDelta <= BEARING_TOLERANCE_DEG && distance2 <= bestForwardDist2) {
              bestForwardDist2 = distance2;
              bestForward = segment;
            } else if (bearingDelta >= 180 - BEARING_TOLERANCE_DEG && distance2 <= bestReverseDist2) {
              bestReverseDist2 = distance2;
              bestReverse = segment;
            }
          }
        }
      }
      if (bestForward) {
        forwardLevels.push(bestForward.level);
        forwardMeta.push(bestForward);
        if (bestForward.closure) forwardClosure = true;
      }
      if (bestReverse) {
        reverseLevels.push(bestReverse.level);
        reverseMeta.push(bestReverse);
        if (bestReverse.closure) reverseClosure = true;
      }
    }

    if (hadCandidate) candidateCount += 1;
    const minimumSamples = Math.max(MIN_MATCHED_SAMPLES, Math.ceil(ROAD_SAMPLES / 2));
    const buildMatch = (levels: number[], closure: boolean, meta: GridSegment[]) => {
      if (levels.length < minimumSamples) return undefined;
      const level = median(levels);
      if (level == null) return undefined;
      const leftHandTraffic = meta.find((value) => value.leftHandTraffic != null)?.leftHandTraffic;
      const partOfTwoWayRoad = meta.find((value) => value.partOfTwoWayRoad != null)?.partOfTwoWayRoad;
      return {
        level,
        closure,
        ...(leftHandTraffic != null ? { leftHandTraffic } : {}),
        ...(partOfTwoWayRoad != null ? { partOfTwoWayRoad } : {}),
      };
    };
    const forward = buildMatch(forwardLevels, forwardClosure, forwardMeta);
    const reverse = roads[roadIndex].oneway
      ? undefined
      : buildMatch(reverseLevels, reverseClosure, reverseMeta);
    if (forward || reverse) {
      matches[roadIndex] = { forward, reverse };
      matchedCount += 1;
    }
  }

  return { matches, matchedCount, candidateCount };
}

function classify(level: number): FlowSegment['congestion'] {
  if (level >= 0.85) return 'free-flow';
  if (level >= 0.55) return 'light';
  return 'jam';
}

export async function fetchTomTomFlowsForRoads(
  roads: RoadSegment[],
  bounds: { south: number; west: number; north: number; east: number },
  signal?: AbortSignal,
) {
  const tiles = tilesForBounds(bounds);
  if (!tiles.length) return { flows: [] as FlowSegment[], matchedCount: 0, candidateCount: 0, coveragePct: 0 };

  const settled = await Promise.allSettled(
    tiles.map(async ({ z, x, y }) => {
      const response = await fetch('/api/traffic?mode=vector&z=' + z + '&x=' + x + '&y=' + y, {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('TomTom vector flow returned HTTP ' + response.status);
      return decodeFlowTile(await response.arrayBuffer(), z, x, y);
    }),
  );
  signal?.throwIfAborted();
  const fulfilled = settled.filter((value): value is PromiseFulfilledResult<FlowPolyline[]> => value.status === 'fulfilled');
  if (!fulfilled.length) {
    const rejected = settled.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    throw rejected?.reason instanceof Error ? rejected.reason : new Error('TomTom vector flow unavailable');
  }

  const match = matchFlowToRoads(roads, fulfilled.flatMap((value) => value.value));
  const flows: FlowSegment[] = [];
  for (let i = 0; i < roads.length; i += 1) {
    const hit = match.matches[i];
    if (!hit) continue;
    const freeFlowSpeedKmh = inferFreeFlowSpeed(roads[i]);
    for (const [direction, directional] of [[1, hit.forward], [-1, hit.reverse]] as const) {
      if (!directional) continue;
      flows.push({
        roadId: roads[i].id,
        direction,
        congestion: classify(directional.level),
        currentSpeedKmh: Math.round(freeFlowSpeedKmh * directional.level),
        freeFlowSpeedKmh,
        delaySeconds: 0,
        level: directional.level,
        closure: directional.closure,
        leftHandTraffic: directional.leftHandTraffic,
        partOfTwoWayRoad: directional.partOfTwoWayRoad,
        source: 'tomtom-live',
      });
    }
  }
  const coveragePct = match.candidateCount > 0
    ? Math.round(match.matchedCount / match.candidateCount * 100)
    : 0;
  return { flows, matchedCount: match.matchedCount, candidateCount: match.candidateCount, coveragePct };
}
