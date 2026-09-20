import { gstime } from 'satellite.js';
import {
  propagateTles,
  propagateTleOrbitEcf,
  type SatelliteCatalog,
  type TleRecord,
} from '@/lib/celestrak';
import type { SpatialEntity } from '@/lib/spatial';
import { holdContinuousRender, releaseContinuousRender } from '@/runtime/gev/render-governor';

type SyncInput = {
  satellites: SpatialEntity[];
  tleRecords: TleRecord[];
  catalog: SatelliteCatalog;
  visible: boolean;
  selectedId: string | null;
  isMobile: boolean;
  cameraHeight: number;
  time: Date;
  continuous: boolean;
};

type OrbitRecord = {
  primitive: any;
  gmstAtBake: number;
  tleKey: string;
};

const CORE_PROPAGATION_MS = 1_000;
const TRACKED_PROPAGATION_MS = 200;
const RING_ROTATION_MS = 1_000;
const DENSE_REFRESH_FRAMES = 300;

function isDenseExtra(record: TleRecord) {
  return /STARLINK|ONEWEB|IRIDIUM/i.test(record.name);
}

export function createSatelliteRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const pointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  pointCollection.show = false;
  const points = new Map<string, any>();
  const detailIds = new Set<string>();
  const trails = new Map<string, any[]>();
  const pointScale = new Cesium.NearFarScalar(50_000, 1.35, 250_000_000, 0.18);
  const pointAlpha = new Cesium.NearFarScalar(2_000_000, 1, 500_000_000, 0.12);
  const baseColor = Cesium.Color.fromCssColorString('#67e8f9');
  const scratchRingRotation = new Cesium.Matrix3();
  let orbit: OrbitRecord | null = null;
  let enabled = false;
  let continuous = false;
  let selectedId: string | null = null;
  let isMobile = false;
  let catalog: SatelliteCatalog = 'core';
  let tleRecords: TleRecord[] = [];
  let coreRecords: TleRecord[] = [];
  let denseRecords: TleRecord[] = [];
  let denseCursor = 0;
  let lastPropagation = 0;
  let lastRingRotation = 0;
  let holdActive = false;
  let destroyed = false;

  const setHold = (next: boolean) => {
    if (next === holdActive) return;
    holdActive = next;
    if (next) holdContinuousRender('satellites');
    else releaseContinuousRender('satellites');
  };

  const clearOrbit = () => {
    if (orbit?.primitive) {
      try { viewer.scene.primitives.remove(orbit.primitive); } catch {}
    }
    orbit = null;
  };

  const hideDetails = () => {
    for (const id of detailIds) viewer.entities.removeById(id);
    detailIds.clear();
    trails.clear();
  };

  const clear = () => {
    pointCollection.removeAll();
    for (const id of points.keys()) entityRegistry.delete(id);
    points.clear();
    hideDetails();
    clearOrbit();
    viewer.scene?.requestRender?.();
  };

  const syncDetail = (
    spatial: SpatialEntity,
    position: any,
    pixelSize: number,
    isSelected: boolean,
    trailPositions: any[],
  ) => {
    let entity = viewer.entities.getById(spatial.id);
    const outlineWidth = isSelected ? 2 : 0.5;
    if (!entity) {
      entity = viewer.entities.add({
        id: spatial.id,
        position,
        point: {
          pixelSize,
          color: baseColor,
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
        entity.point.color = new Cesium.ConstantProperty(baseColor);
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

  const ensureIssOrbit = (records: TleRecord[], time: Date) => {
    const iss = records.find((record) => /ISS.*ZARYA|^ISS\b/i.test(record.name));
    if (!iss) {
      clearOrbit();
      return;
    }
    const tleKey = `${iss.line1}\n${iss.line2}`;
    if (orbit?.tleKey === tleKey) return;
    clearOrbit();
    const bakeDate = new Date(time.getTime());
    const ecf = propagateTleOrbitEcf(iss, bakeDate, 180);
    if (ecf.length < 2) return;
    const pathColor = Cesium.Color.fromCssColorString('#67e8f9');
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: ecf.map((point) => new Cesium.Cartesian3(point.x, point.y, point.z)),
          width: 2.4,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(pathColor.withAlpha(0.58)),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(pathColor.withAlpha(0.32)),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
      allowPicking: false,
    });
    viewer.scene.primitives.add(primitive);
    orbit = { primitive, gmstAtBake: gstime(bakeDate), tleKey };
  };

  const updateOrbitRotation = (time: Date) => {
    if (!orbit?.primitive) return;
    const deltaGmst = gstime(time) - orbit.gmstAtBake;
    const rotation = Cesium.Matrix3.fromRotationZ(-deltaGmst, scratchRingRotation);
    Cesium.Matrix4.fromRotationTranslation(
      rotation,
      Cesium.Cartesian3.ZERO,
      orbit.primitive.modelMatrix,
    );
  };

  const renderSnapshot = (satellites: SpatialEntity[], time: Date, prune = true, updateOrbit = true) => {
    if (!enabled || destroyed) return;
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
        point.show = !detailWanted;
      }

      if (detailWanted) {
        wantedDetails.add(spatial.id);
        syncDetail(spatial, position, pixelSize, isSelected, isSelected && !isIss ? [...trail] : []);
      }
    }

    if (prune) {
      for (const [id, point] of [...points]) {
        if (live.has(id)) continue;
        pointCollection.remove(point);
        points.delete(id);
        entityRegistry.delete(id);
        trails.delete(id);
      }
    }

    if (prune) {
      for (const id of [...detailIds]) {
        if (wantedDetails.has(id)) continue;
        viewer.entities.removeById(id);
        detailIds.delete(id);
      }
    }
    for (const id of wantedDetails) detailIds.add(id);

    if (updateOrbit) ensureIssOrbit(tleRecords, time);
    viewer.scene?.requestRender?.();
  };

  const propagateCore = (time: Date) => {
    const records = catalog === 'dense' ? coreRecords : tleRecords;
    renderSnapshot(propagateTles(records, time), time, catalog !== 'dense', true);
  };

  const propagateDenseChunk = (time: Date) => {
    if (catalog !== 'dense' || !denseRecords.length) return;
    const chunkSize = Math.max(1, Math.ceil(denseRecords.length / DENSE_REFRESH_FRAMES));
    const chunk: TleRecord[] = [];
    for (let index = 0; index < chunkSize; index += 1) {
      chunk.push(denseRecords[denseCursor]);
      denseCursor = (denseCursor + 1) % denseRecords.length;
    }
    renderSnapshot(propagateTles(chunk, time), time, false, false);
  };

  const preRenderRemover = viewer.scene.preRender.addEventListener(() => {
    if (!enabled || !continuous || destroyed) return;
    const nowMs = Date.now();
    const time = new Date(nowMs);
    const interval = selectedId ? TRACKED_PROPAGATION_MS : CORE_PROPAGATION_MS;
    if (nowMs - lastPropagation >= interval) {
      propagateCore(time);
      lastPropagation = nowMs;
    }
    propagateDenseChunk(time);
    if (nowMs - lastRingRotation >= RING_ROTATION_MS) {
      updateOrbitRotation(time);
      lastRingRotation = nowMs;
    }
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(time);
  });

  const configureRecords = (records: TleRecord[], nextCatalog: SatelliteCatalog) => {
    if (records === tleRecords && nextCatalog === catalog) return;
    tleRecords = records;
    catalog = nextCatalog;
    if (catalog === 'dense') {
      coreRecords = records.filter((record) => !isDenseExtra(record));
      denseRecords = records.filter(isDenseExtra);
    } else {
      coreRecords = records;
      denseRecords = [];
    }
    denseCursor = 0;
  };

  return Object.freeze({
    sync({ satellites, tleRecords: nextRecords, catalog: nextCatalog, visible, selectedId: nextSelectedId, isMobile: nextIsMobile, time, continuous: nextContinuous }: SyncInput) {
      if (destroyed) return;
      configureRecords(nextRecords, nextCatalog);
      selectedId = nextSelectedId;
      isMobile = nextIsMobile;
      enabled = visible;
      continuous = visible && nextContinuous && nextRecords.length > 0;
      pointCollection.show = visible;
      setHold(continuous);
      if (!visible) {
        hideDetails();
        if (orbit?.primitive) orbit.primitive.show = false;
        viewer.scene?.requestRender?.();
        return;
      }
      if (orbit?.primitive) orbit.primitive.show = true;
      renderSnapshot(satellites, time, true);
      lastPropagation = continuous ? time.getTime() : 0;
      updateOrbitRotation(time);
      lastRingRotation = time.getTime();
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      setHold(false);
      if (typeof preRenderRemover === 'function') preRenderRemover();
      clear();
      try { viewer.scene.primitives.remove(pointCollection); } catch {}
    },
  });
}
