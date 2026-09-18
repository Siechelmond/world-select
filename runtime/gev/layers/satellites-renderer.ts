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
  const ids = new Set<string>();
  const trails = new Map<string, any[]>();
  let orbitEntity: any = null;
  let orbitMinuteBucket: number | null = null;

  const clearOrbit = () => {
    if (orbitEntity) viewer.entities.remove(orbitEntity);
    orbitEntity = null;
    orbitMinuteBucket = null;
  };

  const clear = () => {
    for (const id of ids) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
    }
    ids.clear();
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

  return Object.freeze({
    sync({ satellites, tleRecords, visible, selectedId, isMobile, cameraHeight, time }: SyncInput) {
      if (!visible) {
        clear();
        return;
      }
      const live = new Set<string>();
      for (const spatial of satellites) {
        live.add(spatial.id);
        entityRegistry.set(spatial.id, spatial);
        const position = Cesium.Cartesian3.fromDegrees(
          spatial.position.longitude,
          spatial.position.latitude,
          spatial.position.altitudeMeters,
        );
        const existing = viewer.entities.getById(spatial.id);
        const isSelected = spatial.id === selectedId;
        const isIss = /ISS.*ZARYA|^ISS\b/i.test(spatial.name);
        const trail = trails.get(spatial.id) ?? [];
        if (isSelected && !isIss) {
          const last = trail[trail.length - 1];
          if (!last || Cesium.Cartesian3.distance(last, position) > 2_000) trail.push(position);
          const maxTrailPoints = isMobile ? 12 : 36;
          while (trail.length > maxTrailPoints) trail.shift();
          trails.set(spatial.id, trail);
        } else if (trail.length) {
          trails.delete(spatial.id);
        }

        const pixelSize = cameraHeight > 5_000_000 ? 4 : cameraHeight > 1_500_000 ? 6 : 8;
        const trailPositions = isSelected && !isIss ? [...trail] : [];
        const showLabel = isSelected || isIss || spatial.name.includes('TIANHE');

        if (existing) {
          existing.position = new Cesium.ConstantPositionProperty(position);
          if (existing.point) existing.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
          if (existing.polyline) {
            existing.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
            existing.polyline.positions = new Cesium.ConstantProperty(trailPositions);
          }
          if (existing.label) {
            existing.label.show = new Cesium.ConstantProperty(showLabel);
            existing.label.text = new Cesium.ConstantProperty(showLabel ? spatial.name : '');
          }
        } else {
          ids.add(spatial.id);
          viewer.entities.add({
            id: spatial.id,
            position,
            point: {
              pixelSize,
              color: Cesium.Color.fromCssColorString('#67e8f9'),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: isSelected ? 2 : 0.5,
            },
            polyline: {
              show: isSelected && trailPositions.length > 1,
              positions: trailPositions,
              width: 1.5,
              material: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.55),
            },
            label: {
              show: showLabel,
              text: showLabel ? spatial.name : '',
              font: '11px sans-serif',
              fillColor: Cesium.Color.WHITE,
              pixelOffset: new Cesium.Cartesian2(10, -10),
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
      const issVisibleAtScale = satellites.some((item) => /ISS.*ZARYA|^ISS\b/i.test(item.name));
      syncIssOrbit(issVisibleAtScale ? tleRecords : [], time);
      viewer.scene?.requestRender?.();
    },
    clear,
    destroy() { clear(); },
  });
}
