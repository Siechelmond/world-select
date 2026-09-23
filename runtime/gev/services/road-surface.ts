import type { RoadSegment } from '@/lib/traffic-vector';

export type RoadSurfaceProfile = {
  heights: number[];
  reliable: boolean;
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

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))];
}

/**
 * Resolves one explicit, depth-tested road profile for both traffic lines and
 * particles. It never classifies the Google 3D mesh, so roofs, trees and
 * bridge undersides cannot be painted as traffic surfaces.
 */
export function createRoadSurfaceResolver(input: { viewer: any; Cesium: any }) {
  const { viewer, Cesium } = input;
  const coordinateCache = new Map<string, number | null>();
  const profileCache = new Map<string, RoadSurfaceProfile>();

  const isSubsurfaceRoad = (road: RoadSegment) =>
    Boolean(road.tunnel || road.covered || Number(road.layer ?? 0) < 0);

  const isElevatedRoad = (road: RoadSegment) =>
    Boolean(road.bridge || Number(road.layer ?? 0) > 0);

  const sample = (coordinate: [number, number]) => {
    const key = coordinate[0].toFixed(6) + ',' + coordinate[1].toFixed(6);
    if (coordinateCache.has(key)) return coordinateCache.get(key) ?? null;
    if (!viewer.scene?.sampleHeightSupported || typeof viewer.scene.sampleHeight !== 'function') {
      coordinateCache.set(key, null);
      return null;
    }
    try {
      const value = viewer.scene.sampleHeight(
        Cesium.Cartographic.fromDegrees(coordinate[0], coordinate[1]),
      );
      const height = Number.isFinite(value) ? Number(value) : null;
      coordinateCache.set(key, height);
      return height;
    } catch {
      coordinateCache.set(key, null);
      return null;
    }
  };

  const fillMissing = (values: Array<number | null>) => {
    const out = [...values];
    for (let index = 0; index < out.length; index += 1) {
      if (out[index] != null) continue;
      let before = index - 1;
      let after = index + 1;
      while (before >= 0 && out[before] == null) before -= 1;
      while (after < out.length && out[after] == null) after += 1;
      if (before >= 0 && after < out.length) {
        const t = (index - before) / (after - before);
        out[index] = (out[before] as number) + ((out[after] as number) - (out[before] as number)) * t;
      } else if (before >= 0) {
        out[index] = out[before];
      } else if (after < out.length) {
        out[index] = out[after];
      }
    }
    return out.map((value) => value ?? 0);
  };

  const clampSlopes = (coordinates: Array<[number, number]>, heights: number[], maxSlope: number) => {
    const out = [...heights];
    for (let index = 1; index < out.length; index += 1) {
      const maxDelta = Math.max(1.5, haversineM(coordinates[index - 1], coordinates[index]) * maxSlope);
      out[index] = Math.max(out[index - 1] - maxDelta, Math.min(out[index - 1] + maxDelta, out[index]));
    }
    for (let index = out.length - 2; index >= 0; index -= 1) {
      const maxDelta = Math.max(1.5, haversineM(coordinates[index], coordinates[index + 1]) * maxSlope);
      out[index] = Math.max(out[index + 1] - maxDelta, Math.min(out[index + 1] + maxDelta, out[index]));
    }
    return out;
  };

  const profileForRoad = (road: RoadSegment, coordinates: Array<[number, number]>): RoadSurfaceProfile => {
    const key = road.id + ':' + coordinates.length + ':' +
      (coordinates[0]?.join(',') ?? '') + ':' + (coordinates[coordinates.length - 1]?.join(',') ?? '');
    const cached = profileCache.get(key);
    if (cached) return cached;
    if (isSubsurfaceRoad(road) || coordinates.length < 2) {
      const profile = { heights: [], reliable: false };
      profileCache.set(key, profile);
      return profile;
    }

    const sampled = coordinates.map(sample);
    const validCount = sampled.filter((value) => value != null).length;
    const minimum = Math.max(2, Math.ceil(coordinates.length * 0.6));
    if (validCount < minimum) {
      const profile = { heights: [], reliable: false };
      profileCache.set(key, profile);
      return profile;
    }

    let heights = fillMissing(sampled);
    if (isElevatedRoad(road)) {
      heights = heights.map((height, index) => {
        const window = heights.slice(Math.max(0, index - 2), Math.min(heights.length, index + 3));
        return percentile(window, 0.5) ?? height;
      });
      heights = clampSlopes(coordinates, heights, 0.35);
    } else {
      // A local lower envelope rejects vegetation and facade/roof samples while
      // still following real terrain changes along the road.
      heights = heights.map((height, index) => {
        const window = heights.slice(Math.max(0, index - 2), Math.min(heights.length, index + 3));
        const lower = percentile(window, 0.25) ?? height;
        return Math.min(height, lower + 3.5);
      });
      heights = clampSlopes(coordinates, heights, 0.22);
    }

    const profile = { heights, reliable: true };
    profileCache.set(key, profile);
    return profile;
  };

  return Object.freeze({
    isSubsurfaceRoad,
    isElevatedRoad,
    profileForRoad,
    reset() {
      coordinateCache.clear();
      profileCache.clear();
    },
  });
}
