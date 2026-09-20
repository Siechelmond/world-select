import type { RoadSegment } from '@/lib/traffic-vector';
import type { TrafficParticle } from '@/lib/traffic-particles';

type PreparedRoad = {
  id: number;
  baseWaypoints: any[];
  laneWaypoints: Map<string, any[]>;
  segmentDist: number[];
  cumulativeDist: number[];
  totalDist: number;
};

type MotionRecord = {
  particle: TrafficParticle;
  road: PreparedRoad;
  waypoints: any[];
  segIdx: number;
  t: number;
};

export function createTrafficMotionModel(input: {
  Cesium: any;
  roads: RoadSegment[];
  particles: TrafficParticle[];
  heightForRoad: (roadId: number) => number;
}) {
  const { Cesium, roads, particles, heightForRoad } = input;
  const prepared = new Map<number, PreparedRoad>();
  const scratch = new Cesium.Cartesian3();
  const MAX_WAYPOINTS_PER_ROAD = 80;

  const simplifiedCoordinates = (coordinates: Array<[number, number]>) => {
    if (coordinates.length <= MAX_WAYPOINTS_PER_ROAD) return coordinates;
    const out: Array<[number, number]> = [];
    const step = (coordinates.length - 1) / (MAX_WAYPOINTS_PER_ROAD - 1);
    let lastIndex = -1;
    for (let slot = 0; slot < MAX_WAYPOINTS_PER_ROAD; slot += 1) {
      const index = slot === MAX_WAYPOINTS_PER_ROAD - 1
        ? coordinates.length - 1
        : Math.round(slot * step);
      if (index === lastIndex) continue;
      out.push(coordinates[index]);
      lastIndex = index;
    }
    return out;
  };

  for (const road of roads) {
    if (road.coordinates.length < 2) continue;
    const height = heightForRoad(road.id);
    const coordinates = simplifiedCoordinates(road.coordinates);
    const baseWaypoints = coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height));
    const segmentDist: number[] = [];
    const cumulativeDist: number[] = [0];
    let totalDist = 0;
    for (let index = 0; index < baseWaypoints.length - 1; index += 1) {
      const distance = Math.max(0.01, Cesium.Cartesian3.distance(baseWaypoints[index], baseWaypoints[index + 1]));
      segmentDist.push(distance);
      totalDist += distance;
      cumulativeDist.push(totalDist);
    }
    prepared.set(road.id, {
      id: road.id,
      baseWaypoints,
      laneWaypoints: new Map(),
      segmentDist,
      cumulativeDist,
      totalDist,
    });
  }

  const lanePathFor = (road: PreparedRoad, offsetM: number) => {
    if (!Number.isFinite(offsetM) || Math.abs(offsetM) < 0.05) return road.baseWaypoints;
    const key = offsetM.toFixed(2);
    const cached = road.laneWaypoints.get(key);
    if (cached) return cached;

    const waypoints = road.baseWaypoints.map((point: any, index: number) => {
      const prev = road.baseWaypoints[Math.max(0, index - 1)];
      const next = road.baseWaypoints[Math.min(road.baseWaypoints.length - 1, index + 1)];
      const tangent = Cesium.Cartesian3.subtract(next, prev, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitudeSquared(tangent) < 1e-6) return Cesium.Cartesian3.clone(point);
      Cesium.Cartesian3.normalize(tangent, tangent);

      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(point, new Cesium.Cartesian3());
      const lateral = Cesium.Cartesian3.cross(up, tangent, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitudeSquared(lateral) < 1e-6) return Cesium.Cartesian3.clone(point);
      Cesium.Cartesian3.normalize(lateral, lateral);
      Cesium.Cartesian3.multiplyByScalar(lateral, offsetM, lateral);
      return Cesium.Cartesian3.add(point, lateral, new Cesium.Cartesian3());
    });

    road.laneWaypoints.set(key, waypoints);
    return waypoints;
  };

  const locate = (road: PreparedRoad, progress: number) => {
    const normalized = ((Number.isFinite(progress) ? progress : 0) % 1 + 1) % 1;
    const target = road.totalDist * normalized;
    let segIdx = Math.max(0, road.segmentDist.length - 1);
    for (let index = 0; index < road.segmentDist.length; index += 1) {
      if (target <= road.cumulativeDist[index + 1]) {
        segIdx = index;
        break;
      }
    }
    const start = road.cumulativeDist[segIdx] ?? 0;
    const length = road.segmentDist[segIdx] ?? 1;
    return { segIdx, t: Math.max(0, Math.min(1, (target - start) / length)) };
  };

  const records: MotionRecord[] = [];
  const jamGroups = new Map<string, { moving: boolean; until: number }>();
  const jamGroupKey = (particle: TrafficParticle) =>
    particle.queueGroup == null
      ? null
      : particle.roadId + ':' + particle.direction + ':' + particle.queueGroup;

  for (const particle of particles) {
    const road = prepared.get(particle.roadId);
    if (!road || !road.segmentDist.length) continue;
    const location = locate(road, particle.progress);
    particle.segmentIndex = location.segIdx;
    records.push({
      particle,
      road,
      waypoints: lanePathFor(road, particle.laneOffsetM),
      segIdx: location.segIdx,
      t: location.t,
    });
    const groupKey = particle.creep ? jamGroupKey(particle) : null;
    if (groupKey && !jamGroups.has(groupKey)) {
      jamGroups.set(groupKey, {
        moving: particle.creep?.moving ?? false,
        until: particle.creep?.until ?? Date.now(),
      });
    }
  }

  const interpolate = (record: MotionRecord, result: any) => {
    const a = record.waypoints[record.segIdx];
    const b = record.waypoints[record.segIdx + 1];
    if (!a || !b) return null;
    return Cesium.Cartesian3.lerp(a, b, record.t, result);
  };

  return Object.freeze({
    count: records.length,
    positionFor(index: number) {
      const record = records[index];
      if (!record) return null;
      return interpolate(record, new Cesium.Cartesian3());
    },
    advance(deltaSeconds: number) {
      const dt = Math.min(Math.max(Number(deltaSeconds) || 0, 0), 0.1);
      if (dt <= 0) return;
      const now = Date.now();

      for (const record of records) {
        const particle = record.particle;
        if (now < particle.stoppedUntil) continue;

        let burst = 1;
        if (particle.creep) {
          const groupKey = jamGroupKey(particle);
          const creepState = groupKey ? jamGroups.get(groupKey) ?? particle.creep : particle.creep;
          if (groupKey && !jamGroups.has(groupKey)) jamGroups.set(groupKey, creepState);

          if (now >= creepState.until) {
            creepState.moving = !creepState.moving;
            const lo = creepState.moving ? 1200 : 1500;
            const hi = creepState.moving ? 3000 : 5000;
            creepState.until = now + lo + Math.random() * (hi - lo);
          }
          if (!creepState.moving) continue;

          // Donor stop/go uses a 2.2x catch-up burst. At close 3D range that
          // can make a near-threshold jam briefly look like free-flow traffic.
          // Keep the donor ceiling, but cap visible jam motion to ~35% of the
          // particle's pre-flow road speed.
          const maxJamMovingMps = Math.max(1.2, particle.baseMps * 0.35);
          burst = Math.min(2.2, maxJamMovingMps / Math.max(0.01, particle.mps));
        }

        let remaining = Math.max(0, particle.mps) * burst * dt;
        while (remaining > 0) {
          const segLen = record.road.segmentDist[record.segIdx] || 1;
          if (particle.direction > 0) {
            const available = (1 - record.t) * segLen;
            if (remaining < available) {
              record.t += remaining / segLen;
              remaining = 0;
            } else {
              remaining -= available;
              record.segIdx += 1;
              record.t = 0;
              if (record.segIdx >= record.road.segmentDist.length) record.segIdx = 0;
              if (!particle.creep && Math.random() < 0.008) {
                particle.stoppedUntil = now + 2000 + Math.random() * 4000;
              }
            }
          } else {
            const available = record.t * segLen;
            if (remaining < available) {
              record.t -= remaining / segLen;
              remaining = 0;
            } else {
              remaining -= available;
              record.segIdx -= 1;
              record.t = 1;
              if (record.segIdx < 0) record.segIdx = record.road.segmentDist.length - 1;
              if (!particle.creep && Math.random() < 0.008) {
                particle.stoppedUntil = now + 2000 + Math.random() * 4000;
              }
            }
          }
        }

        const start = record.road.cumulativeDist[record.segIdx] ?? 0;
        const segLen = record.road.segmentDist[record.segIdx] ?? 1;
        particle.segmentIndex = record.segIdx;
        particle.progress = record.road.totalDist > 0
          ? (start + record.t * segLen) / record.road.totalDist
          : 0;
      }
    },
    writePositions(collection: any, maxCount = records.length) {
      const count = Math.min(maxCount, records.length, Number(collection?.length ?? 0));
      for (let index = 0; index < count; index += 1) {
        const point = collection.get(index);
        if (!point) continue;
        const position = interpolate(records[index], scratch);
        if (position) point.position = position;
      }
    },
  });
}
