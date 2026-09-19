import { projectAircraftPosition } from '@/lib/aircraft';
import type { SpatialEntity } from '@/lib/spatial';

const AIRCRAFT_ICON = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="white" stroke="#111827" stroke-width="2" d="M32 3c3 0 5 4 5 9v12l20 12v6L37 36v13l8 7v5l-13-4-13 4v-5l8-7V36L7 42v-6l20-12V12c0-5 2-9 5-9Z"/></svg>`)}`;

type SyncInput = {
  items: SpatialEntity[];
  visible: boolean;
  selectedId: string | null;
  followSelected: boolean;
  nowMs: number;
  cameraHeight: number;
};

export function createAircraftRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const ids = new Set<string>();
  type TrailPoint = { longitude: number; latitude: number; altitudeMeters: number; observedAtMs: number };
  const trails = new Map<string, TrailPoint[]>();
  let trackedId: string | null = null;

  const trailDistanceKm = (a: TrailPoint, b: TrailPoint) => {
    const toRad = (value: number) => value * Math.PI / 180;
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const dLat = lat2 - lat1;
    const dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  };

  const clearTracking = () => {
    if (viewer.trackedEntity) viewer.trackedEntity = undefined;
    trackedId = null;
  };

  const clear = () => {
    clearTracking();
    for (const id of ids) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
    }
    ids.clear();
    trails.clear();
    viewer.scene?.requestRender?.();
  };

  const updateTrail = (spatial: SpatialEntity, selected: boolean) => {
    if (!selected) {
      trails.delete(spatial.id);
      return [];
    }
    const observedAtMs = Date.parse(spatial.observedAt);
    if (!Number.isFinite(observedAtMs)) return trails.get(spatial.id) ?? [];

    let trail = trails.get(spatial.id) ?? [];
    const point: TrailPoint = { ...spatial.position, observedAtMs };
    const last = trail[trail.length - 1];

    // Only real ADS-B samples extend the history. Local projection moves the
    // icon between polls but must not manufacture a fake breadcrumb every tick.
    if (!last || observedAtMs > last.observedAtMs) {
      const gapMs = last ? observedAtMs - last.observedAtMs : 0;
      const jumpKm = last ? trailDistanceKm(last, point) : 0;
      if (last && (gapMs > 60_000 || jumpKm > 45)) trail = [];
      trail.push(point);
    }

    const cutoff = Date.now() - 5 * 60_000;
    trail = trail.filter((item) => item.observedAtMs >= cutoff).slice(-24);
    trails.set(spatial.id, trail);
    return trail;
  };

  return Object.freeze({
    sync({ items, visible, selectedId, followSelected, nowMs, cameraHeight }: SyncInput) {
      if (!visible) {
        clear();
        return;
      }

      const live = new Set<string>();
      for (const spatial of items) {
        live.add(spatial.id);
        const isSelected = spatial.id === selectedId;
        // Every fresh contact is locally repositioned between ADS-B polls.
        // Camera zoom never causes source acquisition; this is display-only
        // dead reckoning from the latest observed speed/track.
        const canProject = spatial.dataState !== 'STALE';
        const projected = canProject ? projectAircraftPosition(spatial, nowMs) : spatial.position;
        const displayEntity: SpatialEntity = {
          ...spatial,
          position: projected,
          dataState: canProject ? 'ESTIMATED' : spatial.dataState,
          properties: {
            ...spatial.properties,
            displayPosition: canProject
              ? 'locally projected from latest observed ADS-B sample'
              : spatial.dataState === 'STALE'
                ? 'last known stale ADS-B sample'
                : 'last observed ADS-B sample',
          },
        };
        entityRegistry.set(spatial.id, displayEntity);

        const position = Cesium.Cartesian3.fromDegrees(
          projected.longitude,
          projected.latitude,
          projected.altitudeMeters,
        );
        const speed = Number(spatial.properties.groundSpeedKt ?? 0);
        const pixelSize = speed > 250 ? 7 : 6;
        const headingDeg = Number(spatial.properties.trackDeg ?? 0);
        const iconSize = Math.max(14, pixelSize * (isSelected ? 4.1 : 3.2));
        const distanceScale = new Cesium.NearFarScalar(5_000, 1.15, 20_000_000, 0.08);
        const distanceAlpha = new Cesium.NearFarScalar(500_000, 1, 35_000_000, 0.06);
        const trail = updateTrail(spatial, isSelected);
        const trailPositions = trail.map((p) => Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.altitudeMeters));
        const existing = viewer.entities.getById(spatial.id);

        if (existing) {
          existing.position = new Cesium.ConstantPositionProperty(position);
          if (existing.billboard) {
            existing.billboard.width = new Cesium.ConstantProperty(iconSize);
            existing.billboard.height = new Cesium.ConstantProperty(iconSize);
            existing.billboard.rotation = new Cesium.ConstantProperty(Cesium.Math.toRadians(-headingDeg));
            existing.billboard.scaleByDistance = new Cesium.ConstantProperty(distanceScale);
            existing.billboard.translucencyByDistance = new Cesium.ConstantProperty(distanceAlpha);
            existing.billboard.color = new Cesium.ConstantProperty(
              isSelected ? Cesium.Color.fromCssColorString('#fde047') : Cesium.Color.fromCssColorString('#facc15'),
            );
          }
          if (existing.polyline) {
            existing.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
            existing.polyline.positions = new Cesium.ConstantProperty(trailPositions);
          }
          if (existing.label) {
            existing.label.show = new Cesium.ConstantProperty(isSelected);
            existing.label.text = new Cesium.ConstantProperty(spatial.name);
          }
        } else {
          ids.add(spatial.id);
          viewer.entities.add({
            id: spatial.id,
            position,
            billboard: {
              image: AIRCRAFT_ICON,
              width: iconSize,
              height: iconSize,
              rotation: Cesium.Math.toRadians(-headingDeg),
              color: isSelected ? Cesium.Color.fromCssColorString('#fde047') : Cesium.Color.fromCssColorString('#facc15'),
              scaleByDistance: distanceScale,
              translucencyByDistance: distanceAlpha,
              disableDepthTestDistance: 3_000_000,
            },
            polyline: {
              show: isSelected && trailPositions.length > 1,
              positions: trailPositions,
              width: 1.5,
              material: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.48),
              clampToGround: false,
            },
            label: {
              show: isSelected,
              text: spatial.name,
              font: '11px sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#fef08a'),
              pixelOffset: new Cesium.Cartesian2(13, -13),
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.72),
            },
          });
        }
      }

      for (const id of [...ids]) {
        if (live.has(id)) continue;
        viewer.entities.removeById(id);
        entityRegistry.delete(id);
        ids.delete(id);
        trails.delete(id);
      }

      if (followSelected && selectedId) {
        const target = viewer.entities.getById(selectedId);
        if (target && trackedId !== selectedId) {
          viewer.trackedEntity = target;
          trackedId = selectedId;
        }
      } else {
        clearTracking();
      }

      viewer.scene?.requestRender?.();
    },
    clearTracking,
    clear,
    destroy() { clear(); },
  });
}
