import type { SpatialEntity } from '@/lib/spatial';
import type { InfrastructureFeature, InfrastructureCategory } from '@/lib/keyless';

type CategorySet = Set<InfrastructureCategory>;
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

export function createInfrastructureRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  let items: InfrastructureFeature[] = [];
  let categories: CategorySet = new Set();
  let visible = false;
  let cableSignature = '';
  let cableIds = new Set<string>();
  let pointIds = new Set<string>();
  const pointCache = new Map<string, PointRecord>();

  const colorFor = (category: InfrastructureCategory) => {
    if (category === 'cable') return '#22d3ee';
    if (category === 'landing') return '#facc15';
    if (category === 'datacenter') return '#a78bfa';
    return '#38bdf8';
  };

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

  const clearCableEntities = () => {
    for (const id of cableIds) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
    }
    cableIds.clear();
    cableSignature = '';
  };

  const clear = () => {
    clearPointEntities();
    clearCableEntities();
    viewer.scene?.requestRender?.();
  };

  const reconcileCables = () => {
    const cableItems = visible && categories.has('cable')
      ? items.filter((item) => item.category === 'cable' && item.coordinates && item.coordinates.length > 1)
      : [];
    const signature = cableItems.length ? `${cableItems.length}:${cableItems[0]?.id}:${cableItems[cableItems.length - 1]?.id}` : '';
    if (signature === cableSignature) return;
    clearCableEntities();
    cableSignature = signature;
    for (const item of cableItems) {
      const coordinates = item.coordinates ?? [];
      if (coordinates.length < 2) continue;
      cableIds.add(item.id);
      entityRegistry.set(item.id, toSpatial(item));
      viewer.entities.add({
        id: item.id,
        polyline: {
          positions: coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 4)),
          width: 2.4,
          material: Cesium.Color.fromCssColorString(colorFor('cable')).withAlpha(0.82),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
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
      if (item.category === 'cable' || !categories.has(item.category) || !item.point) continue;
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
      const priority = (item.category === 'landing' ? 300 : item.category === 'dam' ? 220 : 200) + (item.name ? 80 : 0);
      candidates.push({ item, position: record.position, distance, priority });
    }
    candidates.sort((a, b) => (b.priority - a.priority) || (a.distance - b.distance) || a.item.id.localeCompare(b.item.id));
    const wanted = new Set(candidates.slice(0, budget).map((entry) => entry.item.id));

    for (const id of [...pointIds]) {
      if (wanted.has(id)) continue;
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
      pointIds.delete(id);
    }

    for (const { item, position } of candidates.slice(0, budget)) {
      entityRegistry.set(item.id, toSpatial(item));
      if (pointIds.has(item.id) && viewer.entities.getById(item.id)) continue;
      pointIds.add(item.id);
      viewer.entities.add({
        id: item.id,
        position,
        point: {
          pixelSize: item.category === 'landing' ? 9 : 7,
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
    reconcileCables();
    reconcilePoints();
    viewer.scene?.requestRender?.();
  };

  const moveEndRemover = viewer.camera?.moveEnd?.addEventListener?.(() => {
    if (!visible) return;
    reconcilePoints();
    viewer.scene?.requestRender?.();
  });

  return Object.freeze({
    sync(nextItems: InfrastructureFeature[], nextVisible: boolean, nextCategories: CategorySet) {
      items = nextItems;
      visible = nextVisible;
      categories = new Set(nextCategories);
      reconcile();
    },
    clear,
    destroy() {
      if (typeof moveEndRemover === 'function') moveEndRemover();
      clear();
      pointCache.clear();
    },
  });
}
