import type { SpatialEntity } from "@/lib/spatial";

const NORMAL_PIXEL_SIZE = 13;
const SELECTED_PIXEL_SIZE = 16;
const RADIO_COLOR = "#34d399";
const NORMAL_OUTLINE = "#071b25";
const SELECTED_OUTLINE = "#ffffff";
const OCCLUSION_SCAN_INTERVAL_MS = 80;

type RadioPointRecord = {
  point: any;
  position: any;
};

export function createRadioRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  );
  const points = new Map<string, RadioPointRecord>();
  let layerVisible = false;
  let destroyed = false;
  let lastScanAt = 0;
  let lastCameraPosition: any = null;

  const updateGlobeOcclusion = (force = false) => {
    if (!layerVisible || destroyed || !points.size) return;
    const cameraPosition = viewer.camera?.positionWC;
    if (!cameraPosition) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cameraMoved = !lastCameraPosition ||
      Cesium.Cartesian3.distanceSquared(cameraPosition, lastCameraPosition) > 1;

    if (!force && (!cameraMoved || now - lastScanAt < OCCLUSION_SCAN_INTERVAL_MS)) return;

    lastScanAt = now;
    lastCameraPosition = Cesium.Cartesian3.clone(cameraPosition, lastCameraPosition ?? new Cesium.Cartesian3());
    const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPosition);
    let changed = false;

    for (const record of points.values()) {
      const nextShow = occluder.isPointVisible(record.position);
      if (record.point.show !== nextShow) {
        record.point.show = nextShow;
        changed = true;
      }
    }

    if (changed) viewer.scene?.requestRender?.();
  };

  const preRenderRemover = viewer.scene?.preRender?.addEventListener?.(() => {
    updateGlobeOcclusion(false);
  });

  const clear = () => {
    collection.removeAll();
    for (const id of points.keys()) entityRegistry.delete(id);
    points.clear();
    lastCameraPosition = null;
    viewer.scene?.requestRender?.();
  };

  return Object.freeze({
    sync(items: SpatialEntity[], visible: boolean, selectedId: string | null = null) {
      layerVisible = visible;
      if (!visible) {
        clear();
        return;
      }

      const live = new Set<string>();
      for (const item of items) {
        live.add(item.id);
        entityRegistry.set(item.id, item);

        const selected = item.id === selectedId;
        const altitude = Math.max(2.5, Number(item.position.altitudeMeters ?? 0));
        const position = Cesium.Cartesian3.fromDegrees(
          item.position.longitude,
          item.position.latitude,
          altitude,
        );

        let record = points.get(item.id);
        if (!record) {
          const point = collection.add({
            id: item.id,
            position,
            pixelSize: selected ? SELECTED_PIXEL_SIZE : NORMAL_PIXEL_SIZE,
            color: Cesium.Color.fromCssColorString(RADIO_COLOR).withAlpha(selected ? 1 : 0.9),
            outlineColor: Cesium.Color.fromCssColorString(selected ? SELECTED_OUTLINE : NORMAL_OUTLINE),
            outlineWidth: selected ? 3 : 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(100_000, 1.15, 12_000_000, 1),
          });
          record = { point, position };
          points.set(item.id, record);
        } else {
          record.position = position;
          record.point.position = position;
          record.point.pixelSize = selected ? SELECTED_PIXEL_SIZE : NORMAL_PIXEL_SIZE;
          record.point.color = Cesium.Color.fromCssColorString(RADIO_COLOR).withAlpha(selected ? 1 : 0.9);
          record.point.outlineColor = Cesium.Color.fromCssColorString(selected ? SELECTED_OUTLINE : NORMAL_OUTLINE);
          record.point.outlineWidth = selected ? 3 : 1;
          record.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          record.point.scaleByDistance = new Cesium.NearFarScalar(100_000, 1.15, 12_000_000, 1);
        }
      }

      for (const [id, record] of [...points]) {
        if (live.has(id)) continue;
        collection.remove(record.point);
        points.delete(id);
        entityRegistry.delete(id);
      }

      updateGlobeOcclusion(true);
      viewer.scene?.requestRender?.();
    },
    clear,
    destroy() {
      destroyed = true;
      layerVisible = false;
      try { preRenderRemover?.(); } catch {}
      clear();
      try { viewer.scene.primitives.remove(collection); } catch {}
    },
  });
}
