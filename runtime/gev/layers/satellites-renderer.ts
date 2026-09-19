import { propagateTleOrbitEcf, type TleRecord } from '@/lib/celestrak';
import type { SpatialEntity } from '@/lib/spatial';

type SyncInput = {
  satellites: SpatialEntity[];
  tleRecords: TleRecord[];
  visible: boolean;
  selectedId: string | null;
  isMobile: boolean;
  cameraHeight: number;
  time: Date;
};

export function createSatelliteRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const pointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const points = new Map<string, any>();
  const detailIds = new Set<string>();
  const trails = new Map<string, any[]>();
  const pointScale = new Cesium.NearFarScalar(50_000, 1.35, 250_000_000, 0.18);
  const pointAlpha = new Cesium.NearFarScalar(2_000_000, 1, 500_000_000, 0.12);
  const baseColor = Cesium.Color.fromCssColorString('#67e8f9');
  let orbitEntity: any = null;
  let orbitMinuteBucket: number | null = null;

  const clearOrbit = () => {
    if (orbitEntity) viewer.entities.remove(orbitEntity);
    orbitEntity = null;
    orbitMinuteBucket = null;
  };

  const clear = () => {
    pointCollection.removeAll();
    for (const id of points.keys()) entityRegistry.delete(id);
    points.clear();
    for (const id of detailIds) viewer.entities.removeById(id);
    detailIds.clear();
    trails.clear();
    clearOrbit();
    viewer.scene?.requestRender?.();
  };

  const syncIssOrbit = (records: TleRecord[], time: Date) => {
    const minuteBucket = Math.floor(time.getTime() / 60_000);
    if (orbitEntity && orbitMinuteBucket === minuteBucket) return;
    clearOrbit();
    const issRecord = records.find((record) => /ISS.*ZARYA|^ISS\b/i.test(record.name));
    if (!issRecord) return;
    const orbit = propagateTleOrbitEcf(issRecord, time, 180);
    if (orbit.length < 2) return;
    orbitEntity = viewer.entities.add({
      id: 'iss-live-orbit',
      polyline: {
        positions: orbit.map((point) => new Cesium.Cartesian3(point.x, point.y, point.z)),
        width: 2.4,
        material: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.58),
      },
    });
    orbitMinuteBucket = minuteBucket;
  };

  const syncDetail = (
    spatial: SpatialEntity,
    position: any,
    pixelSize: number,
    isSelected: boolean,
    trailPositions: any[],
  ) => {
    let entity = viewer.entities.getById(spatial.id);
    const pointColor = baseColor;
    const outlineWidth = isSelected ? 2 : 0.5;
    if (!entity) {
      entity = viewer.entities.add({
        id: spatial.id,
        position,
        point: {
          pixelSize,
          color: pointColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth,
          scaleByDistance: pointScale,
          translucencyByDistance: pointAlpha,
        },
        polyline: {
          show: isSelected && trailPositions.length > 1,
          positions: trailPositions,
          width: 1.5,
          material: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.55),
        },
        label: {
          show: true,
          text: spatial.name,
          font: '11px sans-serif',
          fillColor: Cesium.Color.WHITE,
          pixelOffset: new Cesium.Cartesian2(10, -10),
        },
      });
    } else {
      entity.position = new Cesium.ConstantPositionProperty(position);
      if (entity.point) {
        entity.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
        entity.point.color = new Cesium.ConstantProperty(pointColor);
        entity.point.outlineWidth = new Cesium.ConstantProperty(outlineWidth);
        entity.point.scaleByDistance = new Cesium.ConstantProperty(pointScale);
        entity.point.translucencyByDistance = new Cesium.ConstantProperty(pointAlpha);
      }
      if (entity.polyline) {
        entity.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
        entity.polyline.positions = new Cesium.ConstantProperty(trailPositions);
      }
      if (entity.label) {
        entity.label.show = new Cesium.ConstantProperty(true);
        entity.label.text = new Cesium.ConstantProperty(spatial.name);
      }
    }
    return entity;
  };

  return Object.freeze({
    sync({ satellites, tleRecords, visible, selectedId, isMobile, time }: SyncInput) {
      if (!visible) {
        clear();
        return;
      }

      const live = new Set<string>();
      const wantedDetails = new Set<string>();

      for (const spatial of satellites) {
        live.add(spatial.id);
        entityRegistry.set(spatial.id, spatial);

        const position = Cesium.Cartesian3.fromDegrees(
          spatial.position.longitude,
          spatial.position.latitude,
          spatial.position.altitudeMeters,
        );
        const isSelected = spatial.id === selectedId;
        const isIss = /ISS.*ZARYA|^ISS\b/i.test(spatial.name);
        const persistentLabel = isIss || spatial.name.includes('TIANHE');
        const altitudeMeters = Math.max(0, spatial.position.altitudeMeters || 0);
        const pixelSize = isIss ? 8 : altitudeMeters > 20_000_000 ? 6 : altitudeMeters > 2_000_000 ? 5.5 : 5;

        let trail = trails.get(spatial.id) ?? [];
        if (isSelected && !isIss) {
          const last = trail[trail.length - 1];
          if (!last || Cesium.Cartesian3.distance(last, position) > 2_000) trail.push(position);
          const maxTrailPoints = isMobile ? 12 : 36;
          while (trail.length > maxTrailPoints) trail.shift();
          trails.set(spatial.id, trail);
        } else if (trail.length) {
          trails.delete(spatial.id);
          trail = [];
        }

        const detailWanted = isSelected || persistentLabel;
        let point = points.get(spatial.id);
        if (!point) {
          point = pointCollection.add({
            id: spatial.id,
            position,
            pixelSize,
            color: baseColor,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 0.5,
            scaleByDistance: pointScale,
            translucencyByDistance: pointAlpha,
            show: !detailWanted,
          });
          points.set(spatial.id, point);
        } else {
          point.position = position;
          point.pixelSize = pixelSize;
          point.color = baseColor;
          point.outlineColor = Cesium.Color.WHITE;
          point.outlineWidth = 0.5;
          point.scaleByDistance = pointScale;
          point.translucencyByDistance = pointAlpha;
          point.show = !detailWanted;
        }

        if (detailWanted) {
          wantedDetails.add(spatial.id);
          syncDetail(spatial, position, pixelSize, isSelected, isSelected && !isIss ? [...trail] : []);
        }
      }

      for (const [id, point] of [...points]) {
        if (live.has(id)) continue;
        pointCollection.remove(point);
        points.delete(id);
        entityRegistry.delete(id);
        trails.delete(id);
      }

      for (const id of [...detailIds]) {
        if (wantedDetails.has(id)) continue;
        viewer.entities.removeById(id);
        detailIds.delete(id);
      }
      for (const id of wantedDetails) detailIds.add(id);

      const issInActiveCatalog = satellites.some((item) => /ISS.*ZARYA|^ISS\b/i.test(item.name));
      syncIssOrbit(issInActiveCatalog ? tleRecords : [], time);
      viewer.scene?.requestRender?.();
    },
    clear,
    destroy() {
      clear();
      try { viewer.scene.primitives.remove(pointCollection); } catch {}
    },
  });
}
