import type { FlowSegment, RoadSegment } from '@/lib/traffic-vector';
import {
  laneOffsetMeters,
  particleColorCss,
  particlePixelSize,
  type TrafficParticle,
} from '@/lib/traffic-particles';

type PreparedRoad = {
  id: number;
  source: RoadSegment;
  coordinates: Array<[number, number]>;
  baseWaypoints: any[];
  laneWaypoints: Map<string, any[]>;
  segmentDist: number[];
  cumulativeDist: number[];
  totalDist: number;
  startNode: string;
  endNode: string;
  waypointNodes: Map<number, string>;
  signalNodesByWaypoint: Map<number, number>;
  subsurface: boolean;
  hidden: boolean;
};

type MotionRecord = {
  particle: TrafficParticle;
  road: PreparedRoad;
  waypoints: any[];
  segIdx: number;
  t: number;
  lastBucket: TrafficParticle['bucket'];
};

type Exit = { road: PreparedRoad; direction: 1 | -1; segmentIndex: number };

function coordinateNode(coordinate: [number, number]) {
  return coordinate[0].toFixed(6) + ',' + coordinate[1].toFixed(6);
}

function stableUnit(value: number) {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function createTrafficMotionModel(input: {
  Cesium: any;
  roads: RoadSegment[];
  flows?: FlowSegment[];
  particles: TrafficParticle[];
  heightForRoad: (roadId: number) => number;
  visibleForRoad?: (roadId: number) => boolean;
  pixelScale?: number;
  heightForCoordinate?: (
    roadId: number,
    coordinate: [number, number],
    index: number,
    count: number,
  ) => number | null | undefined;
}) {
  const { Cesium, roads, flows = [], particles, heightForRoad, heightForCoordinate, visibleForRoad, pixelScale = 1 } = input;
  const prepared = new Map<number, PreparedRoad>();
  const scratch = new Cesium.Cartesian3();
  const MAX_WAYPOINTS_PER_ROAD = 80;
  const flowMap = new Map(flows.map((flow) => [flow.roadId + ':' + (flow.direction ?? 0), flow]));
  const nodeUseCount = new Map<number, number>();
  for (const road of roads) {
    for (const nodeId of new Set(road.nodeIds ?? [])) {
      nodeUseCount.set(nodeId, (nodeUseCount.get(nodeId) ?? 0) + 1);
    }
  }

  const simplifiedCoordinates = (road: RoadSegment) => {
    const coordinates = road.coordinates;
    if (coordinates.length <= MAX_WAYPOINTS_PER_ROAD) {
      return { coordinates, originalIndices: coordinates.map((_, index) => index) };
    }
    const keep = new Set<number>([0, coordinates.length - 1]);
    for (const signal of road.trafficSignals ?? []) keep.add(signal.index);
    for (let index = 0; index < (road.nodeIds?.length ?? 0); index += 1) {
      if ((nodeUseCount.get(road.nodeIds![index]) ?? 0) > 1) keep.add(index);
    }
    const slots = Math.max(2, MAX_WAYPOINTS_PER_ROAD - keep.size);
    const step = (coordinates.length - 1) / Math.max(1, slots - 1);
    for (let slot = 0; slot < slots; slot += 1) keep.add(Math.round(slot * step));
    const originalIndices = [...keep]
      .filter((index) => index >= 0 && index < coordinates.length)
      .sort((a, b) => a - b);
    return { coordinates: originalIndices.map((index) => coordinates[index]), originalIndices };
  };

  for (const road of roads) {
    if (road.coordinates.length < 2) continue;
    const baseHeight = heightForRoad(road.id);
    const simplified = simplifiedCoordinates(road);
    const coordinates = simplified.coordinates;
    const baseWaypoints = coordinates.map((coordinate, index) => {
      const [lon, lat] = coordinate;
      const sampledHeight = heightForCoordinate?.(road.id, coordinate, index, coordinates.length);
      const height = typeof sampledHeight === 'number' && Number.isFinite(sampledHeight)
        ? sampledHeight
        : baseHeight;
      return Cesium.Cartesian3.fromDegrees(lon, lat, height);
    });
    const segmentDist: number[] = [];
    const cumulativeDist: number[] = [0];
    let totalDist = 0;
    for (let index = 0; index < baseWaypoints.length - 1; index += 1) {
      const distance = Math.max(0.01, Cesium.Cartesian3.distance(baseWaypoints[index], baseWaypoints[index + 1]));
      segmentDist.push(distance);
      totalDist += distance;
      cumulativeDist.push(totalDist);
    }
    const nodeIds = road.nodeIds ?? [];
    const startNode = nodeIds[0] != null ? 'n:' + nodeIds[0] : 'c:' + coordinateNode(coordinates[0]);
    const endNode = nodeIds[nodeIds.length - 1] != null
      ? 'n:' + nodeIds[nodeIds.length - 1]
      : 'c:' + coordinateNode(coordinates[coordinates.length - 1]);
    const waypointNodes = new Map<number, string>();
    for (let index = 0; index < simplified.originalIndices.length; index += 1) {
      const originalIndex = simplified.originalIndices[index];
      const nodeId = nodeIds[originalIndex];
      if (nodeId != null) waypointNodes.set(index, 'n:' + nodeId);
    }
    const signalNodesByWaypoint = new Map<number, number>();
    for (const signal of road.trafficSignals ?? []) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < coordinates.length; index += 1) {
        const dx = coordinates[index][0] - signal.coordinate[0];
        const dy = coordinates[index][1] - signal.coordinate[1];
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      signalNodesByWaypoint.set(bestIndex, signal.nodeId);
    }
    prepared.set(road.id, {
      id: road.id,
      source: road,
      coordinates,
      baseWaypoints,
      laneWaypoints: new Map(),
      segmentDist,
      cumulativeDist,
      totalDist,
      startNode,
      endNode,
      waypointNodes,
      signalNodesByWaypoint,
      subsurface: Boolean(road.tunnel || road.covered || Number(road.layer ?? 0) < 0),
      hidden: visibleForRoad ? !visibleForRoad(road.id) : false,
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

  const exitsByNode = new Map<string, Exit[]>();
  const addExit = (node: string, exit: Exit) => {
    const list = exitsByNode.get(node) ?? [];
    list.push(exit);
    exitsByNode.set(node, list);
  };
  for (const road of prepared.values()) {
    for (const [waypointIndex, node] of road.waypointNodes) {
      if (waypointIndex < road.segmentDist.length) {
        addExit(node, { road, direction: 1, segmentIndex: waypointIndex });
      }
      if (!road.source.oneway && waypointIndex > 0) {
        addExit(node, { road, direction: -1, segmentIndex: waypointIndex - 1 });
      }
    }
    // Coordinate-key fallback for responses that omit OSM node ids.
    if (!road.waypointNodes.has(0)) addExit(road.startNode, { road, direction: 1, segmentIndex: 0 });
    const lastWaypoint = road.baseWaypoints.length - 1;
    if (!road.waypointNodes.has(lastWaypoint) && !road.source.oneway) {
      addExit(road.endNode, { road, direction: -1, segmentIndex: road.segmentDist.length - 1 });
    }
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
  const jamGroups = new Map<string, { moving: boolean; until: number }>();
  const jamGroupKey = (particle: TrafficParticle) =>
    particle.queueGroup == null ? null : particle.roadId + ':' + particle.direction + ':' + particle.queueGroup;

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
      lastBucket: particle.bucket,
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

  const signalIsRed = (nodeId: number, now: number) => {
    const cycleSeconds = 60;
    const phase = (now / 1000 + Math.abs(nodeId % cycleSeconds)) % cycleSeconds;
    return phase < 30;
  };

  const flowFor = (roadId: number, direction: 1 | -1) =>
    flowMap.get(roadId + ':' + direction) ?? flowMap.get(roadId + ':0');

  const chooseExit = (record: MotionRecord, node: string) => {
    let candidates = (exitsByNode.get(node) ?? []).filter((exit) => {
      const flow = flowFor(exit.road.id, exit.direction);
      return !(flow?.source === 'tomtom-live' && flow.closure);
    });
    const withoutUTurn = candidates.filter((exit) =>
      exit.road.id !== record.road.id || exit.direction === record.particle.direction
    );
    if (withoutUTurn.length) candidates = withoutUTurn;
    if (!candidates.length) return null;
    const seed = record.particle.roadId * 131 + record.particle.laneOrdinal * 17 + Math.round(record.particle.progress * 1000);
    const continuation = candidates.find((exit) =>
      exit.road.id === record.road.id && exit.direction === record.particle.direction
    );
    const alternatives = candidates.filter((exit) => exit !== continuation);
    if (continuation && (!alternatives.length || stableUnit(seed) < 0.68)) return continuation;
    const pool = alternatives.length ? alternatives : candidates;
    return pool[Math.floor(stableUnit(seed + 19) * pool.length) % pool.length];
  };

  const enterRoad = (record: MotionRecord, exit: Exit) => {
    record.road = exit.road;
    record.particle.roadId = exit.road.id;
    record.particle.direction = exit.direction;
    const flow = flowFor(exit.road.id, exit.direction);
    record.particle.highway = exit.road.source.highway;
    if (flow?.source === 'tomtom-live' && Number.isFinite(flow.level)) {
      const level = Math.max(0, Math.min(1, flow.level as number));
      record.particle.flowLevel = level;
      record.particle.bucket = level >= 0.85 ? 'free' : level >= 0.55 ? 'slow' : 'jam';
      record.particle.baseMps = Math.max(0.5, flow.freeFlowSpeedKmh / 3.6);
      record.particle.mps = Math.max(0.25, flow.currentSpeedKmh / 3.6);
    } else {
      record.particle.flowLevel = null;
      record.particle.bucket = null;
      record.particle.mps = record.particle.baseMps;
    }
    record.particle.leftHandTraffic = flow?.leftHandTraffic ?? record.particle.leftHandTraffic;
    record.particle.laneOffsetM = laneOffsetMeters(
      exit.road.source,
      exit.direction,
      record.particle.laneOrdinal,
      record.particle.leftHandTraffic,
    );
    record.waypoints = lanePathFor(exit.road, record.particle.laneOffsetM);
    record.segIdx = exit.segmentIndex;
    record.t = exit.direction > 0 ? 0 : 1;
  };

  return Object.freeze({
    count: records.length,
    positionFor(index: number) {
      const record = records[index];
      if (!record) return null;
      return interpolate(record, new Cesium.Cartesian3());
    },
    isVisible(index: number) {
      const record = records[index];
      return Boolean(record && !record.road.subsurface && !record.road.hidden);
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
          const maxJamMovingMps = Math.max(1.2, particle.baseMps * 0.35);
          burst = Math.min(2.2, maxJamMovingMps / Math.max(0.01, particle.mps));
        }

        let remaining = Math.max(0, particle.mps) * burst * dt;
        let transitions = 0;
        while (remaining > 0 && transitions < 8) {
          const segLen = record.road.segmentDist[record.segIdx] || 1;
          const forward = particle.direction > 0;
          const available = forward ? (1 - record.t) * segLen : record.t * segLen;
          if (remaining < available) {
            record.t += (forward ? 1 : -1) * remaining / segLen;
            remaining = 0;
            continue;
          }

          const signalWaypoint = forward ? record.segIdx + 1 : record.segIdx;
          const signalNode = record.road.signalNodesByWaypoint.get(signalWaypoint);
          if (signalNode != null && signalIsRed(signalNode, now)) {
            record.t = forward ? 0.96 : 0.04;
            particle.stoppedUntil = now + 500;
            remaining = 0;
            continue;
          }

          remaining -= available;
          const reachedWaypoint = forward ? record.segIdx + 1 : record.segIdx;
          const reachedNode = record.road.waypointNodes.get(reachedWaypoint) ??
            (reachedWaypoint === 0
              ? record.road.startNode
              : reachedWaypoint === record.road.baseWaypoints.length - 1
                ? record.road.endNode
                : null);
          if (reachedNode) {
            const exit = chooseExit(record, reachedNode);
            if (exit) {
              enterRoad(record, exit);
              transitions += 1;
              continue;
            }
          }

          record.segIdx += forward ? 1 : -1;
          record.t = forward ? 0 : 1;
          if (record.segIdx >= 0 && record.segIdx < record.road.segmentDist.length) continue;

          const node = forward ? record.road.endNode : record.road.startNode;
          const exit = chooseExit(record, node);
          if (!exit) {
            if (!record.road.source.oneway) {
              particle.direction = forward ? -1 : 1;
              record.segIdx = particle.direction > 0 ? 0 : record.road.segmentDist.length - 1;
              record.t = particle.direction > 0 ? 0 : 1;
            } else {
              record.segIdx = 0;
              record.t = 0;
            }
          } else {
            enterRoad(record, exit);
          }
          transitions += 1;
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
        const record = records[index];
        point.show = !record.road.subsurface && !record.road.hidden;
        if (record.lastBucket !== record.particle.bucket) {
          point.color = Cesium.Color.fromCssColorString(particleColorCss(record.particle))
            .withAlpha(record.particle.bucket ? 0.92 : 0.85);
          point.pixelSize = particlePixelSize(record.particle) * pixelScale;
          record.lastBucket = record.particle.bucket;
        }
        const position = interpolate(record, scratch);
        if (position) point.position = position;
      }
    },
  });
}
