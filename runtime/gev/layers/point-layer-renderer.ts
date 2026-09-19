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
      for (const item of items) {
        live.add(item.id);
        ids.add(item.id);
        entityRegistry.set(item.id, item);
        const style = styleFor(item);
        const altitude = style.altitudeMeters ?? item.position.altitudeMeters ?? 0;
        const position = Cesium.Cartesian3.fromDegrees(
          item.position.longitude,
          item.position.latitude,
          altitude,
        );
        const existing = viewer.entities.getById(item.id);
        if (existing) {
          existing.position = new Cesium.ConstantPositionProperty(position);
          continue;
        }
        viewer.entities.add({
          id: item.id,
          position,
          point: {
            pixelSize: style.pixelSize ?? 8,
            color: Cesium.Color.fromCssColorString(style.color),
            outlineColor: Cesium.Color.fromCssColorString(style.outline ?? "#ffffff"),
            outlineWidth: style.outlineWidth ?? 1,
            ...(style.clampToGround
              ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
              : {}),
            disableDepthTestDistance: style.disableDepthTestDistance ?? 2500,
          },
          label: {
            show: false,
            text: item.name,
          },
        });
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
