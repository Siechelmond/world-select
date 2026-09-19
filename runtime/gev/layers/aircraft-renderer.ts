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

type TrailPoint = {
  longitude: number;
  latitude: number;
  altitudeMeters: number;
  observedAtMs: number;
};

export function createAircraftRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const billboardCollection = viewer.scene.primitives.add(new Cesium.BillboardCollection());
  const billboards = new Map<string, any>();
  const trails = new Map<string, TrailPoint[]>();
  let trackedId: string | null = null;
  let selectedEntityId: string | null = null;
  let destroyed = false;

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
    if (trackedId && viewer.trackedEntity?.id === trackedId) {
      viewer.trackedEntity = undefined;
    }
    trackedId = null;
  };

  const clearSelectedEntity = () => {
    clearTracking();
    if (selectedEntityId) viewer.entities.removeById(selectedEntityId);
    selectedEntityId = null;
  };

  const clear = () => {
    clearSelectedEntity();
    billboardCollection.removeAll();
    for (const id of billboards.keys()) entityRegistry.delete(id);
    billboards.clear();
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

  const syncSelectedEntity = (
    spatial: SpatialEntity | null,
    position: any,
    trailPositions: any[],
  ) => {
    if (!spatial) {
      clearSelectedEntity();
      return null;
    }

    if (selectedEntityId && selectedEntityId !== spatial.id) clearSelectedEntity();

    let entity = viewer.entities.getById(spatial.id);
    if (!entity) {
      entity = viewer.entities.add({
        id: spatial.id,
        position,
        polyline: {
          show: trailPositions.length > 1,
          positions: trailPositions,
          width: 1.5,
          material: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.48),
          clampToGround: false,
        },
        label: {
          show: true,
          text: spatial.name,
          font: '11px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#fef08a'),
          pixelOffset: new Cesium.Cartesian2(13, -13),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.72),
        },
      });
    } else {
      entity.position = new Cesium.ConstantPositionProperty(position);
      if (entity.polyline) {
        entity.polyline.show = new Cesium.ConstantProperty(trailPositions.length > 1);
        entity.polyline.positions = new Cesium.ConstantProperty(trailPositions);
      }
      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(true);
        entity.label.text = new Cesium.ConstantProperty(spatial.name);
      }
    }
    selectedEntityId = spatial.id;
    return entity;
  };

  return Object.freeze({
    sync({ items, visible, selectedId, followSelected, nowMs, cameraHeight }: SyncInput) {
      if (destroyed) return;
      if (!visible) {
        clear();
        return;
      }

      const live = new Set<string>();
      let selectedSpatial: SpatialEntity | null = null;
      let selectedPosition: any = null;
      let selectedTrailPositions: any[] = [];

      for (const spatial of items) {
        live.add(spatial.id);
        const isSelected = spatial.id === selectedId;
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
        const minIconSize = cameraHeight > 3_000_000 ? 12 : 14;
        const iconSize = Math.max(minIconSize, pixelSize * (isSelected ? 4.1 : 3.2));
        const distanceScale = new Cesium.NearFarScalar(5_000, 1.15, 20_000_000, 0.08);
        const distanceAlpha = new Cesium.NearFarScalar(500_000, 1, 35_000_000, 0.06);

        let billboard = billboards.get(spatial.id);
        if (!billboard) {
          billboard = billboardCollection.add({
            id: spatial.id,
            position,
            image: AIRCRAFT_ICON,
            width: iconSize,
            height: iconSize,
            rotation: Cesium.Math.toRadians(-headingDeg),
            color: isSelected
              ? Cesium.Color.fromCssColorString('#fde047')
              : Cesium.Color.fromCssColorString('#facc15'),
            scaleByDistance: distanceScale,
            translucencyByDistance: distanceAlpha,
            disableDepthTestDistance: 3_000_000,
          });
          billboards.set(spatial.id, billboard);
        } else {
          billboard.position = position;
          billboard.width = iconSize;
          billboard.height = iconSize;
          billboard.rotation = Cesium.Math.toRadians(-headingDeg);
          billboard.color = isSelected
            ? Cesium.Color.fromCssColorString('#fde047')
            : Cesium.Color.fromCssColorString('#facc15');
          billboard.scaleByDistance = distanceScale;
          billboard.translucencyByDistance = distanceAlpha;
          billboard.show = true;
        }

        if (isSelected) {
          selectedSpatial = displayEntity;
          selectedPosition = position;
          const trail = updateTrail(spatial, true);
          selectedTrailPositions = trail.map((p) =>
            Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.altitudeMeters)
          );
        } else {
          trails.delete(spatial.id);
        }
      }

      for (const [id, billboard] of [...billboards]) {
        if (live.has(id)) continue;
        billboardCollection.remove(billboard);
        billboards.delete(id);
        entityRegistry.delete(id);
        trails.delete(id);
        if (selectedEntityId === id) clearSelectedEntity();
      }

      const selectedEntity = syncSelectedEntity(
        selectedSpatial,
        selectedPosition,
        selectedTrailPositions,
      );

      if (followSelected && selectedSpatial && selectedEntity) {
        if (trackedId !== selectedSpatial.id) {
          viewer.trackedEntity = selectedEntity;
          trackedId = selectedSpatial.id;
        }
      } else {
        clearTracking();
      }

      viewer.scene?.requestRender?.();
    },
    clearTracking,
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
      try { viewer.scene.primitives.remove(billboardCollection); } catch {}
    },
  });
}
