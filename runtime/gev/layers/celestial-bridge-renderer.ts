import type { SpatialEntity } from "@/lib/spatial";
import type { PlanetPosition } from "@/lib/space";

const MIN_BRIDGE_HEIGHT_M = 13_000_000;
const MIN_DISPLAY_RADIUS_M = 26_000_000;
const MAX_DISPLAY_RADIUS_M = 150_000_000;

function compressedRadius(distanceAu: number) {
  const clamped = Math.max(0.02, distanceAu);
  const normalized = Math.log10(1 + clamped) / Math.log10(32);
  return MIN_DISPLAY_RADIUS_M + normalized * (MAX_DISPLAY_RADIUS_M - MIN_DISPLAY_RADIUS_M);
}

function earthRelative(body: PlanetPosition, earth: PlanetPosition) {
  return {
    x: body.xAu - earth.xAu,
    y: body.yAu - earth.yAu,
    z: body.zAu - earth.zAu,
  };
}

function scenePosition(Cesium: any, vector: { x: number; y: number; z: number }, distanceAu: number) {
  const magnitude = Math.max(1e-8, Math.hypot(vector.x, vector.y, vector.z));
  const radius = compressedRadius(distanceAu);
  return new Cesium.Cartesian3(
    vector.x / magnitude * radius,
    vector.y / magnitude * radius,
    vector.z / magnitude * radius,
  );
}

export function createCelestialBridgeRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const ids = new Set<string>();
  let destroyed = false;

  const clear = () => {
    for (const id of Array.from(ids)) {
      viewer.entities.removeById(id);
      entityRegistry.delete(id);
      ids.delete(id);
    }
    viewer.scene?.requestRender?.();
  };

  const sync = (args: {
    planets: PlanetPosition[];
    visible: boolean;
    cameraHeight: number;
    selectedId?: string | null;
  }) => {
    if (destroyed || viewer.isDestroyed?.()) return;
    if (!args.visible || args.cameraHeight < MIN_BRIDGE_HEIGHT_M) {
      clear();
      return;
    }

    const earth = args.planets.find((item) => item.entity.name === "Earth");
    if (!earth) {
      clear();
      return;
    }

    const targets: Array<{
      id: string;
      entity: SpatialEntity;
      position: any;
      color: string;
      pixelSize: number;
      label: string;
    }> = [];

    const sunVector = { x: -earth.xAu, y: -earth.yAu, z: -earth.zAu };
    const sunDistance = Math.hypot(sunVector.x, sunVector.y, sunVector.z);
    const sunEntity: SpatialEntity = {
      id: "bridge:sun",
      kind: "celestial-body",
      name: "Sun",
      position: { longitude: 0, latitude: 0, altitudeMeters: sunDistance * 149_597_870_700 },
      observedAt: earth.entity.observedAt,
      dataState: "CALCULATED",
      source: earth.entity.source,
      properties: {
        category: "star",
        earthRelativeDistanceAu: Number(sunDistance.toFixed(4)),
        displayFrame: "Earth-relative compressed solar bridge",
        visualScale: "Log-compressed display distance; not physical scene scale",
      },
    };
    targets.push({
      id: sunEntity.id,
      entity: sunEntity,
      position: scenePosition(Cesium, sunVector, sunDistance),
      color: "#fde68a",
      pixelSize: 13,
      label: "SUN",
    });

    for (const planet of args.planets) {
      if (planet.entity.name === "Earth") continue;
      const vector = earthRelative(planet, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      const id = `bridge:${planet.entity.id}`;
      const entity: SpatialEntity = {
        ...planet.entity,
        id,
        properties: {
          ...planet.entity.properties,
          earthRelativeDistanceAu: Number(distanceAu.toFixed(4)),
          displayFrame: "Earth-relative compressed solar bridge",
          visualScale: "Log-compressed display distance; not physical scene scale",
        },
      };
      targets.push({
        id,
        entity,
        position: scenePosition(Cesium, vector, distanceAu),
        color: planet.entity.name === "Mars" ? "#fb923c"
          : planet.entity.name === "Venus" ? "#facc15"
            : planet.entity.name === "Jupiter" ? "#d6b38a"
              : planet.entity.name === "Saturn" ? "#fde68a"
                : planet.entity.name === "Uranus" ? "#67e8f9"
                  : planet.entity.name === "Neptune" ? "#818cf8"
                    : "#cbd5e1",
        pixelSize: planet.entity.name === "Jupiter" ? 9
          : planet.entity.name === "Saturn" ? 8
            : 6,
        label: planet.entity.name.toUpperCase(),
      });
    }

    const nextIds = new Set(targets.map((target) => target.id));
    for (const id of Array.from(ids)) {
      if (!nextIds.has(id)) {
        viewer.entities.removeById(id);
        entityRegistry.delete(id);
        ids.delete(id);
      }
    }

    for (const target of targets) {
      entityRegistry.set(target.id, target.entity);
      ids.add(target.id);

      let item = viewer.entities.getById(target.id);
      if (!item) {
        item = viewer.entities.add({
          id: target.id,
          position: target.position,
          point: {
            pixelSize: target.pixelSize,
            color: Cesium.Color.fromCssColorString(target.color),
            outlineColor: Cesium.Color.fromCssColorString("#020617"),
            outlineWidth: 2,
            scaleByDistance: new Cesium.NearFarScalar(1_000_000, 1.55, 240_000_000, 0.78),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: target.label,
            font: '700 11px "Segoe UI", Arial, sans-serif',
            fillColor: Cesium.Color.fromCssColorString("#e2e8f0"),
            outlineColor: Cesium.Color.fromCssColorString("#020617"),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            scaleByDistance: new Cesium.NearFarScalar(1_000_000, 1.05, 240_000_000, 0.72),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      } else {
        item.position = target.position;
      }

      if (item.point) {
        item.point.pixelSize = target.id === args.selectedId ? target.pixelSize + 4 : target.pixelSize;
      }
    }

    viewer.scene?.requestRender?.();
  };

  return Object.freeze({
    sync,
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
    },
  });
}
