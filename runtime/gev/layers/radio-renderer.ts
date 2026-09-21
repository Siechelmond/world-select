import type { SpatialEntity } from "@/lib/spatial";

const NORMAL_PIXEL_SIZE = 13;
const SELECTED_PIXEL_SIZE = 16;
const RADIO_COLOR = "#f472b6";
const NORMAL_OUTLINE = "#071b25";
const SELECTED_OUTLINE = "#ffffff";

export function createRadioRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  );
  const points = new Map<string, any>();

  const clear = () => {
    collection.removeAll();
    for (const id of points.keys()) entityRegistry.delete(id);
    points.clear();
    viewer.scene?.requestRender?.();
  };

  return Object.freeze({
    sync(items: SpatialEntity[], visible: boolean, selectedId: string | null = null) {
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

        let point = points.get(item.id);
        if (!point) {
          point = collection.add({
            id: item.id,
            position,
            pixelSize: selected ? SELECTED_PIXEL_SIZE : NORMAL_PIXEL_SIZE,
            color: Cesium.Color.fromCssColorString(RADIO_COLOR).withAlpha(selected ? 1 : 0.9),
            outlineColor: Cesium.Color.fromCssColorString(selected ? SELECTED_OUTLINE : NORMAL_OUTLINE),
            outlineWidth: selected ? 3 : 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(100_000, 1.15, 12_000_000, 1),
          });
          points.set(item.id, point);
        } else {
          point.position = position;
          point.pixelSize = selected ? SELECTED_PIXEL_SIZE : NORMAL_PIXEL_SIZE;
          point.color = Cesium.Color.fromCssColorString(RADIO_COLOR).withAlpha(selected ? 1 : 0.9);
          point.outlineColor = Cesium.Color.fromCssColorString(selected ? SELECTED_OUTLINE : NORMAL_OUTLINE);
          point.outlineWidth = selected ? 3 : 1;
          point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          point.scaleByDistance = new Cesium.NearFarScalar(100_000, 1.15, 12_000_000, 1);
          point.show = true;
        }
      }

      for (const [id, point] of [...points]) {
        if (live.has(id)) continue;
        collection.remove(point);
        points.delete(id);
        entityRegistry.delete(id);
      }

      viewer.scene?.requestRender?.();
    },
    clear,
    destroy() {
      clear();
      try { viewer.scene.primitives.remove(collection); } catch {}
    },
  });
}
