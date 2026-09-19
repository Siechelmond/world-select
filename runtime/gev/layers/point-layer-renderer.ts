import type { SpatialEntity } from "@/lib/spatial";

type Style = {
  color: string;
  pixelSize?: number;
  outline?: string;
  outlineWidth?: number;
  altitudeMeters?: number;
  clampToGround?: boolean;
  disableDepthTestDistance?: number;
};

export function createPointLayerRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
  styleFor: (item: SpatialEntity) => Style;
}) {
  const { viewer, Cesium, entityRegistry, styleFor } = input;
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
    sync(items: SpatialEntity[], visible: boolean) {
      if (!visible) {
        clear();
        return;
      }

      const live = new Set<string>();
      for (const item of items) {
        live.add(item.id);
        entityRegistry.set(item.id, item);
        const style = styleFor(item);
        const altitude = style.altitudeMeters ?? item.position.altitudeMeters ?? 0;
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
            pixelSize: style.pixelSize ?? 8,
            color: Cesium.Color.fromCssColorString(style.color),
            outlineColor: Cesium.Color.fromCssColorString(style.outline ?? "#ffffff"),
            outlineWidth: style.outlineWidth ?? 1,
            disableDepthTestDistance: style.disableDepthTestDistance ?? 2500,
          });
          points.set(item.id, point);
        } else {
          point.position = position;
          point.pixelSize = style.pixelSize ?? 8;
          point.color = Cesium.Color.fromCssColorString(style.color);
          point.outlineColor = Cesium.Color.fromCssColorString(style.outline ?? "#ffffff");
          point.outlineWidth = style.outlineWidth ?? 1;
          point.disableDepthTestDistance = style.disableDepthTestDistance ?? 2500;
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
