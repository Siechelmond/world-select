import type { SpatialEntity } from "@/lib/spatial";
import { computePlanetPositions, type PlanetPosition } from "@/lib/space";

const AU_METERS = 149_597_870_700;
const MIN_SOLAR_CONTEXT_HEIGHT_M = 12_000_000;
const MIN_DISPLAY_RADIUS_M = 24_000_000;
const MAX_DISPLAY_RADIUS_M = 155_000_000;
const ORBIT_SAMPLES = 72;

const ORBIT_PERIOD_DAYS: Record<string, number> = {
  Mercury: 87.969,
  Venus: 224.701,
  Earth: 365.256,
  Mars: 686.98,
  Jupiter: 4332.59,
  Saturn: 10759.22,
  Uranus: 30688.5,
  Neptune: 60182,
};

function normalizedDistance(distanceAu: number) {
  return Math.max(0, Math.min(1, Math.log10(1 + Math.max(0.02, distanceAu)) / Math.log10(32)));
}

function compressedRadius(distanceAu: number) {
  return MIN_DISPLAY_RADIUS_M + normalizedDistance(distanceAu) * (MAX_DISPLAY_RADIUS_M - MIN_DISPLAY_RADIUS_M);
}

function revealHeight(distanceAu: number) {
  return MIN_SOLAR_CONTEXT_HEIGHT_M + normalizedDistance(distanceAu) * 34_000_000;
}

function earthRelative(body: PlanetPosition, earth: PlanetPosition) {
  return { x: body.xAu - earth.xAu, y: body.yAu - earth.yAu, z: body.zAu - earth.zAu };
}

function scenePosition(Cesium: any, vector: { x: number; y: number; z: number }, distanceAu: number) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude < 1e-8) return Cesium.Cartesian3.ZERO;
  const radius = compressedRadius(distanceAu);
  return new Cesium.Cartesian3(vector.x / magnitude * radius, vector.y / magnitude * radius, vector.z / magnitude * radius);
}

function basePixelSize(name: string) {
  if (name === "Sun") return 13;
  if (name === "Jupiter") return 9;
  if (name === "Saturn") return 8;
  return 6;
}

function bodyColor(name: string) {
  return name === "Sun" ? "#fde68a"
    : name === "Mars" ? "#fb923c"
      : name === "Venus" ? "#facc15"
        : name === "Jupiter" ? "#d6b38a"
          : name === "Saturn" ? "#fde68a"
            : name === "Uranus" ? "#67e8f9"
              : name === "Neptune" ? "#818cf8"
                : "#cbd5e1";
}

export function createCelestialBridgeRenderer(input: {
  viewer: any;
  Cesium: any;
  entityRegistry: Map<string, SpatialEntity>;
}) {
  const { viewer, Cesium, entityRegistry } = input;
  const bodyIds = new Set<string>();
  const orbitIds = new Set<string>();
  const orbitCache = new Map<string, any[]>();
  let destroyed = false;

  const removeBody = (id: string) => {
    viewer.entities.removeById(id);
    entityRegistry.delete(id);
    bodyIds.delete(id);
  };

  const clearOrbits = () => {
    for (const id of Array.from(orbitIds)) {
      viewer.entities.removeById(id);
      orbitIds.delete(id);
    }
  };

  const clear = () => {
    for (const id of Array.from(bodyIds)) removeBody(id);
    clearOrbits();
    viewer.scene?.requestRender?.();
  };

  const orbitPositions = (name: string, periodDays: number, earth: PlanetPosition) => {
    const epoch = new Date(earth.entity.observedAt);
    const dayKey = Math.floor(epoch.getTime() / 86_400_000);
    const key = `${dayKey}:${name}`;
    const cached = orbitCache.get(key);
    if (cached) return cached;

    const positions: any[] = [];
    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const sampleDate = new Date(epoch.getTime() + periodDays * (index / ORBIT_SAMPLES) * 86_400_000);
      const sample = computePlanetPositions(sampleDate).find((item) => item.entity.name === name);
      if (!sample) continue;
      const vector = earthRelative(sample, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      positions.push(scenePosition(Cesium, vector, distanceAu));
    }
    orbitCache.set(key, positions);
    return positions;
  };

  const sync = (args: {
    planets: PlanetPosition[];
    visible: boolean;
    cameraHeight: number;
    selectedId?: string | null;
    showOrbits?: boolean;
  }) => {
    if (destroyed || viewer.isDestroyed?.()) return;
    if (!args.visible || args.cameraHeight < MIN_SOLAR_CONTEXT_HEIGHT_M) {
      clear();
      return;
    }

    const earth = args.planets.find((item) => item.entity.name === "Earth");
    if (!earth) {
      clear();
      return;
    }

    const candidates: Array<{ id: string; entity: SpatialEntity; position: any; distanceAu: number; name: string }> = [];
    const sunVector = { x: -earth.xAu, y: -earth.yAu, z: -earth.zAu };
    const sunDistance = Math.hypot(sunVector.x, sunVector.y, sunVector.z);

    candidates.push({
      id: "bridge:sun",
      name: "Sun",
      distanceAu: sunDistance,
      position: scenePosition(Cesium, sunVector, sunDistance),
      entity: {
        id: "bridge:sun",
        kind: "celestial-body",
        name: "Sun",
        position: { longitude: 0, latitude: 0, altitudeMeters: sunDistance * AU_METERS },
        observedAt: earth.entity.observedAt,
        dataState: "CALCULATED",
        source: earth.entity.source,
        properties: {
          category: "star",
          earthRelativeDistanceAu: Number(sunDistance.toFixed(4)),
          displayFrame: "Earth-relative solar context",
          visualScale: "Log-compressed display distance; reveal threshold follows Earth-relative distance",
        },
      },
    });

    for (const planet of args.planets) {
      if (planet.entity.name === "Earth") continue;
      const vector = earthRelative(planet, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      const id = `bridge:${planet.entity.id}`;
      candidates.push({
        id,
        name: planet.entity.name,
        distanceAu,
        position: scenePosition(Cesium, vector, distanceAu),
        entity: {
          ...planet.entity,
          id,
          properties: {
            ...planet.entity.properties,
            earthRelativeDistanceAu: Number(distanceAu.toFixed(4)),
            displayFrame: "Earth-relative solar context",
            visualScale: "Log-compressed display distance; reveal threshold follows Earth-relative distance",
          },
        },
      });
    }

    const visibleBodies = candidates.filter((target) => args.cameraHeight >= revealHeight(target.distanceAu));
    const nextBodyIds = new Set(visibleBodies.map((target) => target.id));

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
    }

    for (const target of visibleBodies) {
      entityRegistry.set(target.id, target.entity);
      bodyIds.add(target.id);

      const threshold = revealHeight(target.distanceAu);
      const revealProgress = Math.max(0, Math.min(1, (args.cameraHeight - threshold) / Math.max(8_000_000, threshold * 0.7)));
      const base = basePixelSize(target.name);
      const pixelSize = base * (0.55 + revealProgress * 0.65);
      const selected = target.id === args.selectedId;

      let item = viewer.entities.getById(target.id);
      if (!item) {
        item = viewer.entities.add({
          id: target.id,
          position: target.position,
          point: {
            pixelSize: selected ? pixelSize + 4 : pixelSize,
            color: Cesium.Color.fromCssColorString(bodyColor(target.name)),
            outlineColor: Cesium.Color.fromCssColorString("#020617"),
            outlineWidth: selected ? 3 : 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: target.name.toUpperCase(),
            font: '700 11px "Segoe UI", Arial, sans-serif',
            fillColor: Cesium.Color.fromCssColorString("#e2e8f0"),
            outlineColor: Cesium.Color.fromCssColorString("#020617"),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      } else {
        item.position = new Cesium.ConstantPositionProperty(target.position);
        if (item.point) {
          item.point.pixelSize = new Cesium.ConstantProperty(selected ? pixelSize + 4 : pixelSize);
          item.point.outlineWidth = new Cesium.ConstantProperty(selected ? 3 : 1.5);
        }
      }
    }

    const wantedOrbitIds = new Set<string>();
    if (args.showOrbits) {
      for (const planet of args.planets) {
        const vector = earthRelative(planet, earth);
        const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
        if (args.cameraHeight < revealHeight(distanceAu)) continue;
        const periodDays = ORBIT_PERIOD_DAYS[planet.entity.name];
        if (!periodDays) continue;

        const orbitId = `bridge-orbit:${planet.entity.name.toLowerCase()}`;
        wantedOrbitIds.add(orbitId);
        if (!viewer.entities.getById(orbitId)) {
          viewer.entities.add({
            id: orbitId,
            polyline: {
              positions: orbitPositions(planet.entity.name, periodDays, earth),
              width: planet.entity.name === "Earth" ? 1.8 : 1,
              material: Cesium.Color.fromCssColorString(
                planet.entity.name === "Earth" ? "#38bdf8" : "#94a3b8",
              ).withAlpha(planet.entity.name === "Earth" ? 0.48 : 0.24),
              arcType: Cesium.ArcType.NONE,
            },
          });
        }
        orbitIds.add(orbitId);
      }
    }

    for (const id of Array.from(orbitIds)) {
      if (!wantedOrbitIds.has(id)) {
        viewer.entities.removeById(id);
        orbitIds.delete(id);
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
      orbitCache.clear();
      destroyed = true;
    },
  });
}
