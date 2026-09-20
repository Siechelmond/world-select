import type { FlowSegment, RoadSegment } from '@/lib/traffic-vector';

export type TrafficParticle = {
  roadId: number;
  highway: string;
  progress: number;
  segmentIndex: number;
  direction: 1 | -1;
  laneOffsetM: number;
  queueGroup: number | null;
  mps: number;
  baseMps: number;
  bucket: 'free' | 'slow' | 'jam' | null;
  flowLevel: number | null;
  stoppedUntil: number;
  creep: { moving: boolean; until: number } | null;
};

const SPEED_MPS: Record<string, number> = {
  motorway: 25,
  trunk: 20,
  primary: 14,
  secondary: 11,
  tertiary: 8,
  residential: 5,
  unclassified: 5,
  motorway_link: 16,
  trunk_link: 14,
  primary_link: 12,
  secondary_link: 10,
};

const DENSITY_MULT: Record<string, number> = {
  motorway: 3.0,
  trunk: 2.5,
  primary: 2.0,
  secondary: 1.5,
  tertiary: 1.0,
  residential: 0.5,
  unclassified: 0.4,
  motorway_link: 1.5,
  trunk_link: 1.4,
  primary_link: 1.2,
  secondary_link: 1.1,
};

const SIZE_BY_TYPE: Record<string, number> = {
  motorway: 6,
  trunk: 6,
  primary: 5,
  secondary: 5,
  tertiary: 4,
  residential: 4,
  unclassified: 4,
  motorway_link: 5,
  trunk_link: 5,
  primary_link: 5,
  secondary_link: 4,
};

function haversineM(a: [number, number], b: [number, number]) {
  const radius = 6371000;
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function roadLength(road: RoadSegment) {
  let total = 0;
  for (let i = 1; i < road.coordinates.length; i += 1) total += haversineM(road.coordinates[i - 1], road.coordinates[i]);
  return total;
}

function stableUnit(value: number) {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function flowBucket(flow?: FlowSegment) {
  if (flow?.source !== 'tomtom-live' || !Number.isFinite(flow.level)) return null;
  if ((flow.level as number) >= 0.85) return 'free' as const;
  if ((flow.level as number) >= 0.55) return 'slow' as const;
  return 'jam' as const;
}

function flowSpeedScale(level: number | null) {
  if (!Number.isFinite(level)) return 1;
  return Math.min(1, Math.max(0.15, level as number));
}

function flowDensityMult(level: number | null, jamBoost: boolean) {
  if (!Number.isFinite(level)) return 1;
  return jamBoost
    ? Math.min(4, 1 / Math.max(level as number, 0.25))
    : Math.min(2.5, 1 / Math.max(level as number, 0.4));
}

type QueuePlacement = {
  progress: number;
  direction: 1 | -1;
  group: number;
};

function queuePlacements(
  totalLength: number,
  count: number,
  seed: number,
  oneway: boolean,
): QueuePlacement[] {
  const out: QueuePlacement[] = [];
  let placed = 0;
  let cursor = 0;
  while (placed < count) {
    const platoonSize = Math.min(count - placed, 4 + Math.floor(stableUnit(seed + cursor * 17) * 5));
    const anchor = stableUnit(seed + cursor * 31) * totalLength;
    const direction: 1 | -1 = oneway ? 1 : cursor % 2 === 0 ? 1 : -1;
    let trail = 0;
    for (let j = 0; j < platoonSize; j += 1) {
      if (j > 0) trail += 6 + stableUnit(seed + cursor * 53 + j * 7) * 6;
      const distance = ((anchor - trail) % totalLength + totalLength) % totalLength;
      out.push({ progress: distance / totalLength, direction, group: cursor });
    }
    placed += platoonSize;
    cursor += 1;
  }
  return out;
}

function laneOffsetMeters(
  road: RoadSegment,
  direction: 1 | -1,
  ordinal: number,
) {
  const laneWidthM = 3.2;
  const rawLanes = Number.isFinite(road.lanes) ? Math.round(road.lanes as number) : 0;
  const totalLanes = Math.min(6, Math.max(1, rawLanes || (road.oneway ? 1 : 2)));

  if (road.oneway) {
    if (totalLanes <= 1) return 0;
    const laneIndex = ordinal % totalLanes;
    return (laneIndex - (totalLanes - 1) / 2) * laneWidthM;
  }

  const lanesPerDirection = Math.max(1, Math.floor(totalLanes / 2));
  const laneIndex = ordinal % lanesPerDirection;
  const centerFromRoadCenterM = laneWidthM * (0.5 + laneIndex);
  return direction * centerFromRoadCenterM;
}

export function particlePixelSize(particle: TrafficParticle) {
  return (SIZE_BY_TYPE[particle.highway] ?? 4) + (particle.bucket === 'jam' ? 1 : 0);
}

export function particleColorCss(particle: TrafficParticle) {
  if (particle.bucket === 'free') return '#2ecc71';
  if (particle.bucket === 'slow') return '#f0b23e';
  if (particle.bucket === 'jam') return '#e05252';
  return '#ffffff';
}

export function generateTrafficParticles(
  roads: RoadSegment[],
  flows: FlowSegment[],
  altitude: number,
  cap = 1200,
): TrafficParticle[] {
  const flowByRoad = new Map(flows.map((flow) => [flow.roadId, flow]));
  const candidateRoads = (altitude > 5000
    ? roads.filter((road) => ['motorway', 'trunk', 'primary'].includes(road.highway))
    : roads
  ).filter((road) => roadLength(road) >= 30);

  const spacing = altitude < 1000 ? 30 : altitude < 3000 ? 80 : altitude < 5000 ? 150 : 250;
  const planned = candidateRoads.map((road) => {
    const flow = flowByRoad.get(road.id);
    if (flow?.source === 'tomtom-live' && flow.closure) return 0;
    const level = flow?.source === 'tomtom-live' ? flow.level ?? null : null;
    const bucket = flowBucket(flow);
    const density = (DENSITY_MULT[road.highway] ?? 1) * flowDensityMult(level, bucket === 'jam');
    return Math.max(1, Math.floor(roadLength(road) / spacing * density));
  });

  const budgets = new Array(candidateRoads.length).fill(0);
  let remaining = Math.max(0, cap);
  const order = planned.map((count, index) => ({ count, index })).sort((a, b) => b.count - a.count);
  for (const item of order) {
    if (remaining <= 0) break;
    if (item.count <= 0) continue;
    budgets[item.index] = 1;
    remaining -= 1;
  }
  if (remaining > 0) {
    const remainderTotal = planned.reduce((sum, count, index) => sum + Math.max(0, count - budgets[index]), 0);
    if (remainderTotal > 0) {
      const residuals: Array<{ index: number; residual: number }> = [];
      let assigned = 0;
      for (let i = 0; i < planned.length; i += 1) {
        const roadCap = Math.max(0, planned[i] - budgets[i]);
        if (!roadCap) continue;
        const ideal = roadCap / remainderTotal * remaining;
        const add = Math.min(roadCap, Math.floor(ideal));
        budgets[i] += add;
        assigned += add;
        residuals.push({ index: i, residual: ideal - add });
      }
      let leftover = remaining - assigned;
      residuals.sort((a, b) => b.residual - a.residual);
      let cursor = 0;
      while (leftover > 0 && residuals.length) {
        const index = residuals[cursor % residuals.length].index;
        if (budgets[index] < planned[index]) {
          budgets[index] += 1;
          leftover -= 1;
        }
        cursor += 1;
        if (cursor > residuals.length * 4 && leftover > 0) break;
      }
    }
  }

  const particles: TrafficParticle[] = [];
  for (let roadIndex = 0; roadIndex < candidateRoads.length; roadIndex += 1) {
    const road = candidateRoads[roadIndex];
    const count = budgets[roadIndex];
    if (!count) continue;
    const flow = flowByRoad.get(road.id);
    const level = flow?.source === 'tomtom-live' ? flow.level ?? null : null;
    const bucket = flowBucket(flow);
    const totalLength = roadLength(road);
    const queued = bucket === 'jam'
      ? queuePlacements(totalLength, count, road.id, road.oneway)
      : null;

    for (let i = 0; i < count && particles.length < cap; i += 1) {
      const direction: 1 | -1 = queued?.[i]?.direction ?? (road.oneway ? 1 : i % 2 === 0 ? 1 : -1);
      const progress = queued?.[i]?.progress ?? ((i + stableUnit(road.id * 997 + i * 37)) / count) % 1;
      const queueGroup = queued?.[i]?.group ?? null;
      const laneOrdinal = road.oneway ? i : Math.floor(i / 2);
      // Queue members share one noised base speed so a jam platoon does not
      // collapse into itself or visually overtake while creeping.
      const speedOrdinal = queueGroup ?? i;
      const baseMps = (SPEED_MPS[road.highway] ?? 5) * (0.7 + stableUnit(road.id * 173 + speedOrdinal * 29) * 0.6);
      particles.push({
        roadId: road.id,
        highway: road.highway,
        progress,
        segmentIndex: 0,
        direction,
        laneOffsetM: laneOffsetMeters(road, direction, laneOrdinal),
        queueGroup,
        mps: baseMps * flowSpeedScale(level),
        baseMps,
        bucket,
        flowLevel: Number.isFinite(level) ? level : null,
        stoppedUntil: 0,
        creep: bucket === 'jam'
          ? {
              moving: stableUnit(road.id + (queueGroup ?? i) * 11) < 0.4,
              until: Date.now() + stableUnit(road.id + (queueGroup ?? i) * 19) * 2000,
            }
          : null,
      });
    }
  }
  return particles;
}
