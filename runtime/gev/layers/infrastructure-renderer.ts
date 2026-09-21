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

const OPERATOR_PALETTE = Object.freeze([
  '#38bdf8',
  '#f59e0b',
  '#8b5cf6',
  '#84cc16',
  '#06b6d4',
  '#f97316',
  '#6366f1',
  '#14b8a6',
  '#eab308',
  '#ef4444',
]);

function stableOperatorColor(operator?: string) {
  const normalized = operator?.trim().toLocaleLowerCase();
  if (!normalized) return null;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return OPERATOR_PALETTE[(hash >>> 0) % OPERATOR_PALETTE.length];
}

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
  let cablePendingSignature = '';
  let pointIds = new Set<string>();
  const pointCache = new Map<string, PointRecord>();
  let cableDataSource: any = null;
  let cableSignature = '';
  const cableRegistryIds = new Set<string>();
  const landingRegistryIds = new Set<string>();
  const landingPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({
    blendOption: Cesium.BlendOption.TRANSLUCENT,
  }));
  const landingById = new Map<string, { item: InfrastructureFeature; primitive: any; position: any }>();

  const colorFor = (item: InfrastructureFeature) => {
    if (item.category === 'cable') return item.visualColor ?? '#64748b';
    if (item.category === 'landing') return '#fbbf24';
    if (item.category === 'datacenter') return stableOperatorColor(item.operator) ?? '#94a3b8';
    if (item.category === 'dam') return stableOperatorColor(item.operator) ?? '#64748b';
    return '#64748b';
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
      source: item.source ?? { id: 'bundled-infrastructure', label: 'Bundled infrastructure baseline' },
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

  const clearLandingPoints = () => {
    landingPoints.removeAll();
    landingById.clear();
    for (const id of landingRegistryIds) entityRegistry.delete(id);
    landingRegistryIds.clear();
  };

  const clear = () => {
    clearPointEntities();
    clearCableDataSource();
    clearLandingPoints();
    viewer.scene?.requestRender?.();
  };

  const cableItems = () =>
    items.filter((item) => item.category === 'cable' && item.coordinates && item.coordinates.length > 1);

  const landingItems = () =>
    items.filter((item) => item.category === 'landing' && item.point);

  const landingVisible = (position: any, occluder: any) =>
    !occluder || occluder.isPointVisible(position);

  const reconcileLandingPoints = () => {
    if (!visible || !categories.has('landing') || destroyed) {
      clearLandingPoints();
      return;
    }

    const wanted = landingItems();
    const wantedIds = new Set(wanted.map((item) => item.id));

    for (const [id, record] of [...landingById]) {
      if (wantedIds.has(id)) continue;
      landingPoints.remove(record.primitive);
      landingById.delete(id);
      landingRegistryIds.delete(id);
      entityRegistry.delete(id);
    }

    for (const item of wanted) {
      const point = item.point!;
      if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) ||
          point.longitude < -180 || point.longitude > 180 ||
          point.latitude < -90 || point.latitude > 90) continue;

      let record = landingById.get(item.id);
      if (!record) {
        const position = Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 30);
        const primitive = landingPoints.add({
          id: item.id,
          position,
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString(colorFor(item)).withAlpha(0.96),
          outlineColor: Cesium.Color.fromCssColorString('#111827'),
          outlineWidth: 1.2,
          scaleByDistance: new Cesium.NearFarScalar(50_000, 1.15, 12_000_000, 0.55),
          translucencyByDistance: new Cesium.NearFarScalar(100_000, 1.0, 20_000_000, 0.45),
          disableDepthTestDistance: 0,
        });
        record = { item, primitive, position };
        landingById.set(item.id, record);
      }

      // The registry stores the exact same source record represented by the
      // primitive id, so a pick cannot resolve to a different landing point.
      entityRegistry.set(item.id, toSpatial(item));
      landingRegistryIds.add(item.id);
    }

    const camera = viewer.camera?.positionWC;
    const occluder = camera
      ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera)
      : null;
    for (const record of landingById.values()) {
      record.primitive.show = landingVisible(record.position, occluder);
    }
  };

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
        stroke: Cesium.Color.fromCssColorString('#64748b').withAlpha(0.92),
        fill: Cesium.Color.TRANSPARENT,
        strokeWidth: 2.5,
      });
      if (destroyed || generation !== cableGeneration || !visible || !categories.has('cable')) {
        try { source.destroy?.(); } catch {}
        return;
      }
      source.name = 'TeleGeography Submarine Cables';
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
            Cesium.Color.fromCssColorString(colorFor(item)).withAlpha(0.92),
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
          color: Cesium.Color.fromCssColorString(colorFor(item)),
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
    reconcileLandingPoints();
    void ensureCableDataSource();
    viewer.scene?.requestRender?.();
  };

  const moveEndRemover = viewer.camera?.moveEnd?.addEventListener?.(() => {
    if (!visible) return;
    reconcilePoints();
    reconcileLandingPoints();
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
      try { viewer.scene.primitives.remove(landingPoints); } catch {}
    },
  });
}
