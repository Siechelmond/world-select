import type { SpatialEntity } from '@/lib/spatial';

export function createEarthquakeRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  );
  const points = new Map<string, any>();
  const color = Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.92);
  const outlineColor = Cesium.Color.fromCssColorString('#fff7ed');

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
      for (const spatial of items) {
        live.add(spatial.id);
        entityRegistry.set(spatial.id, spatial);
        const magnitude = Number(spatial.properties.magnitude ?? 0);
        const pixelSize = Math.max(7, Math.min(20, 5 + magnitude * 2));
        const position = Cesium.Cartesian3.fromDegrees(
          spatial.position.longitude,
          spatial.position.latitude,
          25,
        );

        let point = points.get(spatial.id);
        if (!point) {
          point = collection.add({
            id: spatial.id,
            position,
            pixelSize,
            color,
            outlineColor,
            outlineWidth: 1,
            disableDepthTestDistance: 3500,
          });
          points.set(spatial.id, point);
        } else {
          point.position = position;
          point.pixelSize = pixelSize;
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
