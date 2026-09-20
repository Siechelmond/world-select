import type { ModeledVehicle, RoadSegment } from '@/lib/traffic-vector';

type PreparedRoad = {
  id: number;
  waypoints: any[];
  segmentDist: number[];
  segmentHeadingDeg: number[];
  cumulativeDist: number[];
  totalDist: number;
};

type MotionRecord = {
  vehicle: ModeledVehicle;
  road: PreparedRoad;
  segIdx: number;
  t: number;
};

/**
 * Direct ws-donor traffic hot-path port adapted to injected Cesium.
 * All lon/lat -> Cartesian conversion and segment distances are built once.
 * Per frame is bounded segment advance + Cartesian3.lerp only.
 */
export function createTrafficMotionModel(input: {
  Cesium: any;
  roads: RoadSegment[];
  vehicles: ModeledVehicle[];
  heightForRoad: (roadId: number) => number;
}) {
  const { Cesium, roads, vehicles, heightForRoad } = input;
  const prepared = new Map<number, PreparedRoad>();
  const scratch = new Cesium.Cartesian3();

  const bearingDeg = (a: [number, number], b: [number, number]) => {
    const toRad = (value: number) => value * Math.PI / 180;
    const toDeg = (value: number) => value * 180 / Math.PI;
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLon = toRad(b[0] - a[0]);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  for (const road of roads) {
    if (road.coordinates.length < 2) continue;
    const height = heightForRoad(road.id);
    const waypoints = road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height));
    const segmentDist: number[] = [];
    const segmentHeadingDeg: number[] = [];
    const cumulativeDist: number[] = [0];
    let totalDist = 0;
    for (let index = 0; index < waypoints.length - 1; index += 1) {
      const distance = Math.max(0.01, Cesium.Cartesian3.distance(waypoints[index], waypoints[index + 1]));
      segmentDist.push(distance);
      segmentHeadingDeg.push(bearingDeg(road.coordinates[index], road.coordinates[index + 1]));
      totalDist += distance;
      cumulativeDist.push(totalDist);
    }
    prepared.set(road.id, { id: road.id, waypoints, segmentDist, segmentHeadingDeg, cumulativeDist, totalDist });
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

  const motions: MotionRecord[] = [];
  for (const vehicle of vehicles) {
    const road = prepared.get(vehicle.roadId);
    if (!road || road.segmentDist.length < 1) continue;
    const location = locate(road, vehicle.progress);
    vehicle.headingDeg = road.segmentHeadingDeg[location.segIdx] ?? vehicle.headingDeg;
    motions.push({ vehicle, road, segIdx: location.segIdx, t: location.t });
  }

  const interpolate = (record: MotionRecord, result: any) => {
    const a = record.road.waypoints[record.segIdx];
    const b = record.road.waypoints[record.segIdx + 1];
    if (!a || !b) return null;
    return Cesium.Cartesian3.lerp(a, b, record.t, result);
  };

  const writeOne = (record: MotionRecord, point: any) => {
    if (!point) return;
    const position = interpolate(record, scratch);
    if (position) point.position = position;
  };

  return Object.freeze({
    count: motions.length,
    positionFor(index: number) {
      const record = motions[index];
      if (!record) return null;
      const result = new Cesium.Cartesian3();
      return interpolate(record, result);
    },
    advance(deltaSeconds: number) {
      const dt = Math.min(Math.max(Number(deltaSeconds) || 0, 0), 0.1);
      if (dt <= 0) return;
      for (const record of motions) {
        const speedMps = Math.max(0, Number(record.vehicle.speedKmh) || 0) / 3.6;
        let remaining = speedMps * dt;
        while (remaining > 0) {
          const segLen = record.road.segmentDist[record.segIdx] || 1;
          const available = (1 - record.t) * segLen;
          if (remaining < available) {
            record.t += remaining / segLen;
            remaining = 0;
          } else {
            remaining -= available;
            record.segIdx = (record.segIdx + 1) % record.road.segmentDist.length;
            record.t = 0;
          }
        }
        const start = record.road.cumulativeDist[record.segIdx] ?? 0;
        const segLen = record.road.segmentDist[record.segIdx] ?? 1;
        record.vehicle.segmentIndex = record.segIdx;
        record.vehicle.headingDeg = record.road.segmentHeadingDeg[record.segIdx] ?? record.vehicle.headingDeg;
        record.vehicle.progress = record.road.totalDist > 0
          ? (start + record.t * segLen) / record.road.totalDist
          : 0;
      }
    },
    writePositions(collection: any, maxCount = motions.length) {
      const count = Math.min(maxCount, motions.length, Number(collection?.length ?? 0));
      for (let index = 0; index < count; index += 1) {
        writeOne(motions[index], collection.get(index));
      }
    },
  });
}
