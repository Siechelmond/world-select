import { projectAircraftPosition } from '@/lib/aircraft';
import { CLASS_SCALE_2D, type AircraftClassKey } from '@/lib/aircraft-class';
import type { SpatialEntity } from '@/lib/spatial';

function svgIcon(path: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="white" stroke="#111827" stroke-width="2" d="${path}"/></svg>`)}`;
}

const AIRCRAFT_ICONS: Record<string, string> = {
  helicopter: svgIcon("M30 8h4v18h15v5H36v6h10v4H36v15h-8V41H18v-4h10v-6H15v-5h15V8Zm-9 16h22v4H21z"),
  fastjet: svgIcon("M32 3 38 24 57 35v7L38 36l6 19-12-7-12 7 6-19-19 6v-7l19-11L32 3Z"),
  widebody: svgIcon("M32 3c4 0 6 5 6 11v11l20 10v8L38 38v10l9 8v5l-15-4-15 4v-5l9-8V38L6 43v-8l20-10V14c0-6 2-11 6-11Z"),
  turboprop: svgIcon("M32 5c3 0 5 4 5 9v12l17 8v7l-17-4v12l8 7v4l-13-3-13 3v-4l8-7V37l-17 4v-7l17-8V14c0-5 2-9 5-9Z"),
  light: svgIcon("M32 7c3 0 4 4 4 8v13l15 7v6l-15-3v10l7 6v4l-11-3-11 3v-4l7-6V38l-15 3v-6l15-7V15c0-4 1-8 4-8Z"),
  airliner: svgIcon("M32 3c3 0 5 4 5 9v12l20 12v6L37 36v13l8 7v5l-13-4-13 4v-5l8-7V36L7 42v-6l20-12V12c0-5 2-9 5-9Z"),
  quadjet: svgIcon("M32 2c4 0 6 5 6 12v10l21 11v8L38 38v10l9 8v5l-15-4-15 4v-5l9-8V38L5 43v-8l21-11V14c0-7 2-12 6-12Z"),
  bizjet: svgIcon("M32 5c3 0 5 4 5 9v11l18 9v6l-18-4v12l8 7v5l-13-4-13 4v-5l8-7V36L9 40v-6l18-9V14c0-5 2-9 5-9Z"),
  uav: svgIcon("M32 11l5 13 20 8v5l-20-3v11l7 6v4l-12-3-12 3v-4l7-6V34L7 37v-5l20-8 5-13Z"),
  glider: svgIcon("M32 10c2 0 3 3 3 7v9l25 7v4l-25-2v11l7 6v4l-10-3-10 3v-4l7-6V35L4 37v-4l25-7v-9c0-4 1-7 3-7Z"),
};

function aircraftIcon(spatial: SpatialEntity) {
  const klass = String(spatial.properties.aircraftClass ?? "airliner").toLowerCase();
  return AIRCRAFT_ICONS[klass] ?? AIRCRAFT_ICONS.airliner;
}

type SyncInput = {
  items: SpatialEntity[];
  visible: boolean;
  selectedId: string | null;
  followSelected: boolean;
  nowMs: number;
  cameraHeight: number;
  mapMode: "satellite" | "map" | "nasa" | "photoreal";
};

type TrailPoint = {
  longitude: number;
  latitude: number;
  altitudeMeters: number;
  observedAtMs: number;
};

type ModelSpec = {
  url: string;
  scale: number;
  bellyM: number;
};

type ModelRecord = {
  model: any;
  specKey: string;
};

const MODEL_HEADING_OFFSET_DEG = 180;
const MODEL_MAX = 40;
const PHOTOREAL_MODEL_MAX = 12;
const MODEL_ADD_DISTANCE_M = 220_000;
const MODEL_CAMERA_HEIGHT_M = 350_000;
const PHOTOREAL_MODEL_CAMERA_HEIGHT_M = 12_000;
const PHOTOREAL_AIRCRAFT_RADIUS_M = 300_000;

const MODEL_SPECS: Record<AircraftClassKey, ModelSpec> = {
  helicopter: { url: '/models/bell206.glb', scale: 1, bellyM: 1.66 },
  light: { url: '/models/c172.glb', scale: 1, bellyM: 1.36 },
  turboprop: { url: '/models/atr72.glb', scale: 1, bellyM: 3.81 },
  widebody: { url: '/models/b789.glb', scale: 1, bellyM: 7.81 },
  bizjet: { url: '/models/citation2.glb', scale: 1, bellyM: 2.86 },
  uav: { url: '/models/mq9.glb', scale: 1, bellyM: 2.02 },
  fastjet: { url: '/models/jet.glb', scale: 1, bellyM: 2.4 },
  airliner: { url: '/models/airplane.glb', scale: 1, bellyM: 6.719 },
  quadjet: { url: '/models/airplane.glb', scale: 1, bellyM: 6.719 },
  glider: { url: '/models/airplane.glb', scale: 1, bellyM: 2.0 },
};

function aircraftClass(spatial: SpatialEntity): AircraftClassKey {
  const value = String(spatial.properties.aircraftClass ?? 'airliner').toLowerCase() as AircraftClassKey;
  return MODEL_SPECS[value] ? value : 'airliner';
}

function modelSpec(spatial: SpatialEntity): ModelSpec {
  return MODEL_SPECS[aircraftClass(spatial)];
}

export function createAircraftRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const billboardCollection = viewer.scene.primitives.add(new Cesium.BillboardCollection());
  const modelCollection = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const billboards = new Map<string, any>();
  const models = new Map<string, ModelRecord>();
  const modelPending = new Set<string>();
  const modelGeneration = new Map<string, number>();
  const modelFailures = new Set<string>();
  const trails = new Map<string, TrailPoint[]>();
  let trackedId: string | null = null;
  let selectedEntityId: string | null = null;
  let destroyed = false;

  const releaseModel = (id: string) => {
    const record = models.get(id);
    const pending = modelPending.has(id);
    if (record || pending) modelGeneration.set(id, (modelGeneration.get(id) ?? 0) + 1);
    if (record) {
      try { modelCollection.remove(record.model); } catch {}
      models.delete(id);
    }
    const billboard = billboards.get(id);
    if (billboard) billboard.show = true;
  };

  const releaseAllModels = () => {
    for (const id of [...models.keys()]) releaseModel(id);
    for (const id of modelPending) {
      modelGeneration.set(id, (modelGeneration.get(id) ?? 0) + 1);
      const billboard = billboards.get(id);
      if (billboard) billboard.show = true;
    }
  };

  const ensureModel = async (spatial: SpatialEntity) => {
    const id = spatial.id;
    if (destroyed || models.has(id) || modelPending.has(id) || modelFailures.has(id)) return;
    if (models.size + modelPending.size >= MODEL_MAX) return;
    const spec = modelSpec(spatial);
    const specKey = `${spec.url}@${spec.scale}`;
    const generation = modelGeneration.get(id) ?? 0;
    modelPending.add(id);
    let model: any = null;
    try {
      model = await Cesium.Model.fromGltfAsync({
        url: spec.url,
        scale: spec.scale,
        minimumPixelSize: 10,
        id,
        asynchronous: false,
      });
    } catch {
      if ((modelGeneration.get(id) ?? 0) === generation) modelFailures.add(id);
      modelPending.delete(id);
      return;
    }
    modelPending.delete(id);
    if (
      destroyed ||
      (modelGeneration.get(id) ?? 0) !== generation ||
      models.has(id) ||
      !billboards.has(id)
    ) {
      try { model.destroy?.(); } catch {}
      return;
    }
    model.show = false;
    model._wsSpecKey = specKey;
    modelCollection.add(model);
    models.set(id, { model, specKey });
  };

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
    if (trackedId && viewer.trackedEntity?.id === trackedId) viewer.trackedEntity = undefined;
    trackedId = null;
  };

  const clearSelectedEntity = () => {
    clearTracking();
    if (selectedEntityId) viewer.entities.removeById(selectedEntityId);
    selectedEntityId = null;
  };

  const clear = () => {
    clearSelectedEntity();
    releaseAllModels();
    billboardCollection.removeAll();
    for (const id of billboards.keys()) entityRegistry.delete(id);
    billboards.clear();
    trails.clear();
    modelFailures.clear();
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

  const syncSelectedEntity = (spatial: SpatialEntity | null, position: any, trailPositions: any[]) => {
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

  const modelPosition = (spatial: SpatialEntity, position: any, spec: ModelSpec) => {
    if (spatial.position.altitudeMeters > 120 || !viewer.scene?.sampleHeightSupported) return position;
    try {
      const carto = Cesium.Cartographic.fromCartesian(position);
      const sampled = viewer.scene.sampleHeight(carto);
      if (!Number.isFinite(sampled)) return position;
      return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, sampled + spec.bellyM);
    } catch {
      return position;
    }
  };

  const updateModel = (spatial: SpatialEntity, position: any, headingDeg: number) => {
    const record = models.get(spatial.id);
    const billboard = billboards.get(spatial.id);
    if (!record || !billboard) return false;
    const spec = modelSpec(spatial);
    const expected = `${spec.url}@${spec.scale}`;
    if (record.specKey !== expected) {
      releaseModel(spatial.id);
      return false;
    }
    const displayPosition = modelPosition(spatial, position, spec);
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians((Number.isFinite(headingDeg) ? headingDeg : 0) + MODEL_HEADING_OFFSET_DEG),
      0,
      0,
    );
    Cesium.Transforms.headingPitchRollToFixedFrame(
      displayPosition,
      hpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      record.model.modelMatrix,
    );
    if (record.model.ready === false) {
      record.model.show = false;
      billboard.show = true;
      return false;
    }
    record.model.show = true;
    billboard.show = false;
    return true;
  };

  return Object.freeze({
    sync({ items, visible, selectedId, followSelected, nowMs, cameraHeight, mapMode }: SyncInput) {
      if (destroyed) return;
      if (!visible) {
        clear();
        return;
      }

      const modelLimit = mapMode === 'photoreal' ? PHOTOREAL_MODEL_MAX : MODEL_MAX;
      const modelRegime = cameraHeight <= (
        mapMode === 'photoreal'
          ? PHOTOREAL_MODEL_CAMERA_HEIGHT_M
          : MODEL_CAMERA_HEIGHT_M
      );
      if (!modelRegime) releaseAllModels();

      const live = new Set<string>();
      let selectedSpatial: SpatialEntity | null = null;
      let selectedPosition: any = null;
      let selectedTrailPositions: any[] = [];
      const modelCandidates: Array<{ spatial: SpatialEntity; position: any; heading: number; distance: number }> = [];
      const cameraPosition = viewer.camera?.positionWC;
      const occluder = cameraPosition
        ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPosition)
        : null;

      for (const spatial of items) {
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
        const cameraDistance = cameraPosition
          ? Cesium.Cartesian3.distance(cameraPosition, position)
          : 0;
        const photorealVisible =
          mapMode !== 'photoreal' ||
          !cameraPosition ||
          isSelected ||
          cameraDistance <= PHOTOREAL_AIRCRAFT_RADIUS_M;
        if (!photorealVisible) {
          entityRegistry.delete(spatial.id);
          continue;
        }
        live.add(spatial.id);
        const speed = Number(spatial.properties.groundSpeedKt ?? 0);
        const pixelSize = speed > 250 ? 7 : 6;
        const headingDeg = Number(spatial.properties.trackDeg ?? 0);
        const horizonVisible = !occluder || occluder.isPointVisible(position);
        const klass = aircraftClass(spatial);
        const classScale = CLASS_SCALE_2D[klass];
        const minIconSize = cameraHeight > 3_000_000 ? 12 : 14;
        const iconSize = Math.max(minIconSize, pixelSize * (isSelected ? 4.1 : 3.2) * classScale);
        const distanceScale = new Cesium.NearFarScalar(5_000, 1.15, 20_000_000, 0.08);
        const distanceAlpha = new Cesium.NearFarScalar(500_000, 1, 35_000_000, 0.06);

        let billboard = billboards.get(spatial.id);
        if (!billboard) {
          billboard = billboardCollection.add({
            id: spatial.id,
            position,
            image: aircraftIcon(spatial),
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
          billboard.image = aircraftIcon(spatial);
          billboard.width = iconSize;
          billboard.height = iconSize;
          billboard.rotation = Cesium.Math.toRadians(-headingDeg);
          billboard.color = isSelected
            ? Cesium.Color.fromCssColorString('#fde047')
            : Cesium.Color.fromCssColorString('#facc15');
          billboard.scaleByDistance = distanceScale;
          billboard.translucencyByDistance = distanceAlpha;
          billboard.show = horizonVisible;
        }

        if (modelRegime && cameraPosition && horizonVisible) {
          if (cameraDistance <= MODEL_ADD_DISTANCE_M) {
            modelCandidates.push({ spatial: displayEntity, position, heading: headingDeg, distance: cameraDistance });
          }
        }

        if (isSelected && horizonVisible) {
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

      const modelWanted = new Set(
        modelCandidates
          .sort((a, b) => a.distance - b.distance)
          .slice(0, modelLimit)
          .map((entry) => entry.spatial.id),
      );

      for (const id of [...models.keys()]) {
        if (!live.has(id) || !modelWanted.has(id)) releaseModel(id);
      }
      for (const entry of modelCandidates.slice(0, modelLimit)) {
        void ensureModel(entry.spatial);
        updateModel(entry.spatial, entry.position, entry.heading);
      }

      for (const [id, billboard] of [...billboards]) {
        if (live.has(id)) continue;
        releaseModel(id);
        billboardCollection.remove(billboard);
        billboards.delete(id);
        entityRegistry.delete(id);
        trails.delete(id);
        modelFailures.delete(id);
        modelGeneration.delete(id);
        if (selectedEntityId === id) clearSelectedEntity();
      }

      const selectedEntity = syncSelectedEntity(selectedSpatial, selectedPosition, selectedTrailPositions);
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
      try { viewer.scene.primitives.remove(modelCollection); } catch {}
      try { viewer.scene.primitives.remove(billboardCollection); } catch {}
    },
  });
}
