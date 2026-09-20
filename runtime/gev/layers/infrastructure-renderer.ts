import type { SpatialEntity } from '@/lib/spatial';
import type { InfrastructureFeature, InfrastructureCategory } from '@/lib/keyless';

type CategorySet = Set<InfrastructureCategory>;
type MapMode = "photoreal" | "satellite" | "map" | "nasa";
type PointRecord = { item: InfrastructureFeature; position: any };

const GLOBAL_HEIGHT_M = 3_000_000;
const REGIONAL_HEIGHT_M = 200_000;
const GLOBAL_ACTIVE = 80;
const REGIONAL_ACTIVE = 200;
const LOCAL_ACTIVE = 420;

function pointBudget(cameraHeight: number) {
  if (!Number.isFinite(cameraHeight) || cameraHeight >= GLOBAL_HEIGHT_M) return GLOBAL_ACTIVE;
  if (cameraHeight >= REGIONAL_HEIGHT_M) return REGIONAL_ACTIVE;
  return LOCAL_ACTIVE;
}

function featureCollection(features: object[]) {
  return { type: 'FeatureCollection', features };
}

export function createInfrastructureRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  let items: InfrastructureFeature[] = [];
  let categories: CategorySet = new Set();
  let visible = false;
  let mapMode: MapMode = "satellite";
  let destroyed = false;

  let cableGeneration = 0;
  let landingGeneration = 0;
  let cablePendingSignature = '';
  let landingPendingSignature = '';
  let pointIds = new Set<string>();
  const pointCache = new Map<string, PointRecord>();
  let cableDataSource: any = null;
  let landingDataSource: any = null;
  let cableSignature = '';
  let landingSignature = '';
  const cableRegistryIds = new Set<string>();
  const landingRegistryIds = new Set<string>();

  const colorFor = (category: InfrastructureCategory) => {
    if (category === 'cable') return '#22d3ee';
    if (category === 'landing') return '#facc15';
    if (category === 'datacenter') return '#a78bfa';
    return '#38bdf8';
  };

  const classificationType = () =>
    mapMode === "photoreal"
      ? Cesium.ClassificationType.CESIUM_3D_TILE
      : Cesium.ClassificationType.TERRAIN;

  const toSpatial = (item: InfrastructureFeature): SpatialEntity => {
    const first = item.point ?? (item.coordinates?.[0]
      ? { longitude: item.coordinates[0][0], latitude: item.coordinates[0][1] }
      : { longitude: 0, latitude: 0 });
    return {
      id: item.id,
      kind: 'infrastructure',
      name: item.name,
      position: { longitude: first.longitude, latitude: first.latitude, altitudeMeters: 0 },
      observedAt: new Date().toISOString(),
      dataState: 'OBSERVED',
      source: item.source ?? { id: 'ws-donor-infrastructure', label: 'ws-donor bundled baseline' },
      properties: { category: item.category, operator: item.operator ?? '' },
    };
  };

  const clearPointEntities = () => {
    for (const id of pointIds) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
    }
    pointIds.clear();
  };

  const removeDataSource = (source: any) => {
    if (!source) return;
    try { viewer.dataSources.remove(source, true); } catch {}
  };

  const clearCableDataSource = () => {
    cableGeneration += 1;
    cablePendingSignature = '';
    removeDataSource(cableDataSource);
    cableDataSource = null;
    cableSignature = '';
    for (const id of cableRegistryIds) entityRegistry.delete(id);
    cableRegistryIds.clear();
  };

  const clearLandingDataSource = () => {
    landingGeneration += 1;
    landingPendingSignature = '';
    removeDataSource(landingDataSource);
    landingDataSource = null;
    landingSignature = '';
    for (const id of landingRegistryIds) entityRegistry.delete(id);
    landingRegistryIds.clear();
  };

  const clear = () => {
    clearPointEntities();
    clearCableDataSource();
    clearLandingDataSource();
    viewer.scene?.requestRender?.();
  };

  const cableItems = () =>
    items.filter((item) => item.category === 'cable' && item.coordinates && item.coordinates.length > 1);

  const landingItems = () =>
    items.filter((item) => item.category === 'landing' && item.point);

  const applyCableClassification = () => {
    if (!cableDataSource) return;
    const next = classificationType();
    for (const entity of cableDataSource.entities.values) {
      if (entity.polyline) entity.polyline.classificationType = new Cesium.ConstantProperty(next);
    }
    viewer.scene?.requestRender?.();
  };

  const ensureCableDataSource = async () => {
    if (!visible || !categories.has('cable') || destroyed) {
      clearCableDataSource();
      return;
    }
    const sourceItems = cableItems();
    const signature = sourceItems.length
      ? `${sourceItems.length}:${sourceItems[0]?.id}:${sourceItems[sourceItems.length - 1]?.id}`
      : '';
    if (!signature) {
      clearCableDataSource();
      return;
    }
    if ((cableDataSource && signature === cableSignature) || signature === cablePendingSignature) {
      applyCableClassification();
      return;
    }

    clearCableDataSource();
    const generation = cableGeneration;
    cablePendingSignature = signature;

    const geo = featureCollection(sourceItems.map((item) => ({
      type: 'Feature',
      id: item.id,
      properties: { id: item.id, name: item.name, operator: item.operator ?? '' },
      geometry: { type: 'LineString', coordinates: item.coordinates },
    })));

    try {
      const source = await Cesium.GeoJsonDataSource.load(geo, {
        clampToGround: true,
        stroke: Cesium.Color.fromCssColorString(colorFor('cable')).withAlpha(0.92),
        fill: Cesium.Color.TRANSPARENT,
        strokeWidth: 2.5,
      });
      if (destroyed || generation !== cableGeneration || !visible || !categories.has('cable')) {
        try { source.destroy?.(); } catch {}
        return;
      }
      source.name = 'ws-donor Submarine Cables';
      await viewer.dataSources.add(source);
      if (destroyed || generation !== cableGeneration || !visible || !categories.has('cable')) {
        removeDataSource(source);
        return;
      }
      cableDataSource = source;
      cableSignature = signature;
      cablePendingSignature = '';
      const byId = new Map(sourceItems.map((item) => [item.id, item]));
      for (const entity of source.entities.values) {
        const item = byId.get(String(entity.id));
        if (!item) continue;
        if (entity.polyline) {
          entity.polyline.width = new Cesium.ConstantProperty(2.5);
          entity.polyline.material = new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(colorFor('cable')).withAlpha(0.92),
          );
          entity.polyline.classificationType = new Cesium.ConstantProperty(classificationType());
        }
        entityRegistry.set(item.id, toSpatial(item));
        cableRegistryIds.add(item.id);
      }
      viewer.scene?.requestRender?.();
    } catch {
      if (generation === cableGeneration) clearCableDataSource();
    }
  };

  const ensureLandingDataSource = async () => {
    if (!visible || !categories.has('landing') || destroyed) {
      clearLandingDataSource();
      return;
    }
    const sourceItems = landingItems();
    const signature = sourceItems.length
      ? `${sourceItems.length}:${sourceItems[0]?.id}:${sourceItems[sourceItems.length - 1]?.id}`
      : '';
    if (!signature) {
      clearLandingDataSource();
      return;
    }
    if ((landingDataSource && signature === landingSignature) || signature === landingPendingSignature) return;

    clearLandingDataSource();
    const generation = landingGeneration;
    landingPendingSignature = signature;

    const geo = featureCollection(sourceItems.map((item) => ({
      type: 'Feature',
      id: item.id,
      properties: { id: item.id, name: item.name },
      geometry: { type: 'Point', coordinates: [item.point!.longitude, item.point!.latitude] },
    })));

    try {
      const source = await Cesium.GeoJsonDataSource.load(geo, {
        clampToGround: true,
        markerColor: Cesium.Color.fromCssColorString(colorFor('landing')),
        markerSize: 7,
      });
      if (destroyed || generation !== landingGeneration || !visible || !categories.has('landing')) {
        try { source.destroy?.(); } catch {}
        return;
      }
      source.name = 'ws-donor Cable Landing Points';
      await viewer.dataSources.add(source);
      if (destroyed || generation !== landingGeneration || !visible || !categories.has('landing')) {
        removeDataSource(source);
        return;
      }
      landingDataSource = source;
      landingSignature = signature;
      landingPendingSignature = '';
      const byId = new Map(sourceItems.map((item) => [item.id, item]));
      for (const entity of source.entities.values) {
        const item = byId.get(String(entity.id));
        if (!item) continue;
        if (entity.point) {
          entity.point.pixelSize = new Cesium.ConstantProperty(7);
          entity.point.color = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(colorFor('landing')));
          entity.point.outlineColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString('#020617'));
          entity.point.outlineWidth = new Cesium.ConstantProperty(1);
          entity.point.disableDepthTestDistance = new Cesium.ConstantProperty(0);
        }
        entityRegistry.set(item.id, toSpatial(item));
        landingRegistryIds.add(item.id);
      }
      viewer.scene?.requestRender?.();
    } catch {
      if (generation === landingGeneration) clearLandingDataSource();
    }
  };

  const reconcilePoints = () => {
    if (!visible) {
      clearPointEntities();
      return;
    }
    const height = Number(viewer.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY);
    const budget = pointBudget(height);
    const camera = viewer.camera?.positionWC;
    const candidates: Array<{ item: InfrastructureFeature; position: any; distance: number; priority: number }> = [];
    const occluder = camera ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera) : null;

    for (const item of items) {
      if ((item.category !== 'datacenter' && item.category !== 'dam') || !categories.has(item.category) || !item.point) continue;
      let record = pointCache.get(item.id);
      if (!record) {
        record = {
          item,
          position: Cesium.Cartesian3.fromDegrees(item.point.longitude, item.point.latitude, 12),
        };
        pointCache.set(item.id, record);
      }
      if (occluder && !occluder.isPointVisible(record.position)) continue;
      const distance = camera ? Cesium.Cartesian3.distance(camera, record.position) : Number.POSITIVE_INFINITY;
      const priority = (item.category === 'dam' ? 220 : 200) + (item.name ? 80 : 0);
      candidates.push({ item, position: record.position, distance, priority });
    }

    candidates.sort((a, b) => (b.priority - a.priority) || (a.distance - b.distance) || a.item.id.localeCompare(b.item.id));
    const selected = candidates.slice(0, budget);
    const wanted = new Set(selected.map((entry) => entry.item.id));

    for (const id of [...pointIds]) {
      if (wanted.has(id)) continue;
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
      pointIds.delete(id);
    }

    for (const { item, position } of selected) {
      entityRegistry.set(item.id, toSpatial(item));
      if (pointIds.has(item.id) && viewer.entities.getById(item.id)) continue;
      pointIds.add(item.id);
      viewer.entities.add({
        id: item.id,
        position,
        point: {
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString(colorFor(item.category)),
          outlineColor: Cesium.Color.fromCssColorString('#020617'),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 3000,
        },
      });
    }
  };

  const reconcile = () => {
    if (!visible) {
      clear();
      return;
    }
    reconcilePoints();
    void ensureLandingDataSource();
    void ensureCableDataSource();
    viewer.scene?.requestRender?.();
  };

  const moveEndRemover = viewer.camera?.moveEnd?.addEventListener?.(() => {
    if (!visible) return;
    reconcilePoints();
    viewer.scene?.requestRender?.();
  });

  return Object.freeze({
    sync(nextItems: InfrastructureFeature[], nextVisible: boolean, nextCategories: CategorySet, nextMapMode: MapMode = "satellite") {
      const modeChanged = mapMode !== nextMapMode;
      items = nextItems;
      visible = nextVisible;
      categories = new Set(nextCategories);
      mapMode = nextMapMode;
      if (modeChanged) applyCableClassification();
      reconcile();
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (typeof moveEndRemover === 'function') moveEndRemover();
      clear();
      pointCache.clear();
    },
  });
}
