import type { SpatialEntity } from "@/lib/spatial";
import { computePlanetPositions, type PlanetPosition } from "@/lib/space";

const MIN_SOLAR_CONTEXT_HEIGHT_M = 6_500_000;
const ORBIT_SAMPLES = 72;
const EARTH_RADIUS_M = 6_371_000;
const OBLIQUITY_J2000_RAD = 23.43928 * Math.PI / 180;

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

function revealHeight(distanceAu: number) {
  return MIN_SOLAR_CONTEXT_HEIGHT_M + normalizedDistance(distanceAu) * 24_000_000;
}

function earthRelative(body: PlanetPosition, earth: PlanetPosition) {
  return {
    x: body.xAu - earth.xAu,
    y: body.yAu - earth.yAu,
    z: body.zAu - earth.zAu,
  };
}

function eclipticJ2000ToEquatorial(vector: { x: number; y: number; z: number }) {
  const cosE = Math.cos(OBLIQUITY_J2000_RAD);
  const sinE = Math.sin(OBLIQUITY_J2000_RAD);
  return {
    x: vector.x,
    y: vector.y * cosE - vector.z * sinE,
    z: vector.y * sinE + vector.z * cosE,
  };
}

function inertialToFixed(Cesium: any, vector: any, date: Date) {
  const julian = Cesium.JulianDate.fromDate(date);
  const matrix =
    Cesium.Transforms.computeIcrfToFixedMatrix?.(julian) ??
    Cesium.Transforms.computeTemeToPseudoFixedMatrix?.(julian);

  if (!matrix) return vector;
  return Cesium.Matrix3.multiplyByVector(matrix, vector, new Cesium.Cartesian3());
}

function displayRadius(distanceAu: number, cameraHeight: number) {
  const cameraRange = Math.max(cameraHeight + EARTH_RADIUS_M, 18_000_000);
  const fraction = 0.20 + normalizedDistance(distanceAu) * 0.62;
  return cameraRange * Math.min(0.82, fraction);
}

function scenePosition(
  Cesium: any,
  vector: { x: number; y: number; z: number },
  distanceAu: number,
  date: Date,
  cameraHeight: number,
) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude < 1e-8) return Cesium.Cartesian3.ZERO;

  const equatorial = eclipticJ2000ToEquatorial(vector);
  const inertialDirection = new Cesium.Cartesian3(
    equatorial.x / magnitude,
    equatorial.y / magnitude,
    equatorial.z / magnitude,
  );
  const fixedDirection = inertialToFixed(Cesium, inertialDirection, date);
  return Cesium.Cartesian3.multiplyByScalar(
    Cesium.Cartesian3.normalize(fixedDirection, new Cesium.Cartesian3()),
    displayRadius(distanceAu, cameraHeight),
    new Cesium.Cartesian3(),
  );
}

function basePixelSize(name: string) {
  if (name === "Jupiter") return 9;
  if (name === "Saturn") return 8;
  return 6;
}

function bodyColor(name: string) {
  return name === "Mars" ? "#fb923c"
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

  const orbitPositions = (
    name: string,
    periodDays: number,
    earth: PlanetPosition,
    cameraHeight: number,
  ) => {
    const epoch = new Date(earth.entity.observedAt);
    const heightBucket = Math.round(cameraHeight / 2_000_000);
    const dayKey = Math.floor(epoch.getTime() / 86_400_000);
    const key = `${dayKey}:${heightBucket}:${name}`;
    const cached = orbitCache.get(key);
    if (cached) return cached;

    const positions: any[] = [];
    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const sampleDate = new Date(epoch.getTime() + periodDays * (index / ORBIT_SAMPLES) * 86_400_000);
      const sample = computePlanetPositions(sampleDate).find((item) => item.entity.name === name);
      if (!sample) continue;

      // The orbit is sampled through time, but rendered in the current selected-time
      // celestial frame so the whole curve stays coherent around the native Cesium Sun.
      const vector = earthRelative(sample, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      positions.push(scenePosition(Cesium, vector, distanceAu, epoch, cameraHeight));
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

    const epoch = new Date(earth.entity.observedAt);
    const candidates: Array<{
      id: string;
      entity: SpatialEntity;
      position: any;
      distanceAu: number;
      name: string;
    }> = [];

    // Do not create a second Sun. Cesium already renders the scene Sun.
    for (const planet of args.planets) {
      if (planet.entity.name === "Earth") continue;

      const vector = earthRelative(planet, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      const id = `bridge:${planet.entity.id}`;

      candidates.push({
        id,
        name: planet.entity.name,
        distanceAu,
        position: scenePosition(Cesium, vector, distanceAu, epoch, args.cameraHeight),
        entity: {
          ...planet.entity,
          id,
          properties: {
            ...planet.entity.properties,
            earthRelativeDistanceAu: Number(distanceAu.toFixed(4)),
            displayFrame: "Earth-relative J2000 celestial context",
            visualScale: "Distance-aware compressed Earth-context display scale",
            sunRepresentation: "Native Cesium scene Sun",
          },
        },
      });
    }

    const visibleBodies = candidates.filter(
      (target) => args.cameraHeight >= revealHeight(target.distanceAu),
    );
    const nextBodyIds = new Set(visibleBodies.map((target) => target.id));

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
    }

    for (const target of visibleBodies) {
      entityRegistry.set(target.id, target.entity);
      bodyIds.add(target.id);

      const threshold = revealHeight(target.distanceAu);
      const revealProgress = Math.max(
        0,
        Math.min(1, (args.cameraHeight - threshold) / Math.max(6_000_000, threshold * 0.55)),
      );
      const base = basePixelSize(target.name);
      const pixelSize = base * (0.62 + revealProgress * 0.55);
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

        const positions = orbitPositions(
          planet.entity.name,
          periodDays,
          earth,
          args.cameraHeight,
        );

        const existing = viewer.entities.getById(orbitId);
        if (!existing) {
          viewer.entities.add({
            id: orbitId,
            polyline: {
              positions,
              width: planet.entity.name === "Earth" ? 1.8 : 1,
              material: Cesium.Color.fromCssColorString(
                planet.entity.name === "Earth" ? "#38bdf8" : "#94a3b8",
              ).withAlpha(planet.entity.name === "Earth" ? 0.48 : 0.24),
              arcType: Cesium.ArcType.NONE,
            },
          });
        } else if (existing.polyline) {
          existing.polyline.positions = new Cesium.ConstantProperty(positions);
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
