import type { SpatialEntity } from "@/lib/spatial";
import type { InfrastructureFeature, InfrastructureCategory } from "@/lib/keyless";

type CategorySet = Set<InfrastructureCategory>;

export function createInfrastructureRenderer(input: {
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

  const colorFor = (category: InfrastructureCategory) => {
    if (category === "cable") return "#22d3ee";
    if (category === "landing") return "#facc15";
    if (category === "datacenter") return "#a78bfa";
    return "#38bdf8";
  };

  const toSpatial = (item: InfrastructureFeature): SpatialEntity => {
    const first = item.point ?? (item.coordinates?.[0]
      ? { longitude: item.coordinates[0][0], latitude: item.coordinates[0][1] }
      : { longitude: 0, latitude: 0 });
    return {
      id: item.id,
      kind: "infrastructure",
      name: item.name,
      position: { longitude: first.longitude, latitude: first.latitude, altitudeMeters: 0 },
      observedAt: new Date().toISOString(),
      dataState: "OBSERVED",
      source: { id: "osm-overpass", label: "OpenStreetMap / Overpass", url: "https://www.openstreetmap.org/" },
      properties: {
        category: item.category,
        operator: item.operator ?? "",
      },
    };
  };

  return Object.freeze({
    sync(items: InfrastructureFeature[], visible: boolean, categories: CategorySet) {
      if (!visible) {
        clear();
        return;
      }
      const live = new Set<string>();
      for (const item of items) {
        if (!categories.has(item.category)) continue;
        live.add(item.id);
        ids.add(item.id);
        entityRegistry.set(item.id, toSpatial(item));
        const existing = viewer.entities.getById(item.id);
        if (existing) continue;

        if (item.category === "cable" && item.coordinates?.length) {
          viewer.entities.add({
            id: item.id,
            polyline: {
              positions: item.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 4)),
              width: 2.6,
              material: Cesium.Color.fromCssColorString(colorFor(item.category)).withAlpha(0.9),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
        } else if (item.point) {
          viewer.entities.add({
            id: item.id,
            position: Cesium.Cartesian3.fromDegrees(item.point.longitude, item.point.latitude, 4),
            point: {
              pixelSize: item.category === "landing" ? 10 : 8,
              color: Cesium.Color.fromCssColorString(colorFor(item.category)),
              outlineColor: Cesium.Color.fromCssColorString("#020617"),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 3000,
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
