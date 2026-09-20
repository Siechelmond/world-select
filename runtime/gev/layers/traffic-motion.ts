import type { RoadSegment } from '@/lib/traffic-vector';
import type { TrafficParticle } from '@/lib/traffic-particles';

type PreparedRoad = {
  id: number;
  waypoints: any[];
  segmentDist: number[];
  cumulativeDist: number[];
  totalDist: number;
};

type MotionRecord = {
  particle: TrafficParticle;
  road: PreparedRoad;
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

  for (const road of roads) {
    if (road.coordinates.length < 2) continue;
    const height = heightForRoad(road.id);
    const waypoints = road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height));
    const segmentDist: number[] = [];
    const cumulativeDist: number[] = [0];
    let totalDist = 0;
    for (let index = 0; index < waypoints.length - 1; index += 1) {
      const distance = Math.max(0.01, Cesium.Cartesian3.distance(waypoints[index], waypoints[index + 1]));
      segmentDist.push(distance);
      totalDist += distance;
      cumulativeDist.push(totalDist);
    }
    prepared.set(road.id, { id: road.id, waypoints, segmentDist, cumulativeDist, totalDist });
  }

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
  for (const particle of particles) {
    const road = prepared.get(particle.roadId);
    if (!road || !road.segmentDist.length) continue;
    const location = locate(road, particle.progress);
    particle.segmentIndex = location.segIdx;
    records.push({ particle, road, segIdx: location.segIdx, t: location.t });
  }

  const interpolate = (record: MotionRecord, result: any) => {
    const a = record.road.waypoints[record.segIdx];
    const b = record.road.waypoints[record.segIdx + 1];
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
          if (now >= particle.creep.until) {
            particle.creep.moving = !particle.creep.moving;
            const lo = particle.creep.moving ? 1200 : 1500;
            const hi = particle.creep.moving ? 3000 : 5000;
            particle.creep.until = now + lo + Math.random() * (hi - lo);
          }
          if (!particle.creep.moving) continue;
          burst = 2.2;
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
              if (Math.random() < 0.008) particle.stoppedUntil = now + 2000 + Math.random() * 4000;
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
              if (Math.random() < 0.008) particle.stoppedUntil = now + 2000 + Math.random() * 4000;
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
