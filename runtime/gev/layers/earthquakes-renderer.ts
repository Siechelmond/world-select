import type { SpatialEntity } from '@/lib/spatial';

export function createEarthquakeRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const ids = new Set<string>();

  const clear = () => {
    for (const id of ids) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
    }
    ids.clear();
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
        const position = Cesium.Cartesian3.fromDegrees(
          spatial.position.longitude,
          spatial.position.latitude,
          0,
        );
        const existing = viewer.entities.getById(spatial.id);
        const pixelSize = Math.max(7, Math.min(20, 5 + magnitude * 2));
        if (existing) {
          existing.position = new Cesium.ConstantPositionProperty(position);
          if (existing.point) existing.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
        } else {
          ids.add(spatial.id);
          viewer.entities.add({
            id: spatial.id,
            position,
            point: {
              pixelSize,
              color: Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.92),
              outlineColor: Cesium.Color.fromCssColorString('#fff7ed'),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
        }
      }
      for (const id of [...ids]) {
        if (live.has(id)) continue;
        viewer.entities.removeById(id);
        entityRegistry.delete(id);
        ids.delete(id);
      }
      viewer.scene?.requestRender?.();
    },
    clear,
    destroy() { clear(); },
  });
}
