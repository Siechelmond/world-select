import type { SpatialEntity } from "@/lib/spatial";
import { computePlanetPositions, type PlanetPosition } from "@/lib/space";

const AU_METERS = 149_597_870_700;
const OBLIQUITY_J2000_RAD = 23.43928 * Math.PI / 180;
const ORBIT_SAMPLES = 96;

const PLANET_RADIUS_KM: Record<string, number> = {
  Mercury: 2439.7,
  Venus: 6051.8,
  Earth: 6371.0,
  Mars: 3389.5,
  Jupiter: 69911,
  Saturn: 58232,
  Uranus: 25362,
  Neptune: 24622,
};

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

function physicalScenePosition(
  Cesium: any,
  vectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const equatorial = eclipticJ2000ToEquatorial(vectorAu);
  const inertialMeters = new Cesium.Cartesian3(
    equatorial.x * AU_METERS,
    equatorial.y * AU_METERS,
    equatorial.z * AU_METERS,
  );
  return inertialToFixed(Cesium, inertialMeters, date);
}

function isRenderableCartesian(Cesium: any, value: any) {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return false;
  return Cesium.Cartesian3.magnitudeSquared(value) > 1;
}

function bodyColor(name: string) {
  return name === "Mercury" ? "#a8a29e"
    : name === "Venus" ? "#eab308"
      : name === "Mars" ? "#f97316"
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
  ) => {
    const epoch = new Date(earth.entity.observedAt);
    const dayKey = Math.floor(epoch.getTime() / 86_400_000);
    const key = `${dayKey}:${name}`;
    const cached = orbitCache.get(key);
    if (cached) return cached;

    const positions: any[] = [];
    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const sampleDate = new Date(
        epoch.getTime() + periodDays * (index / ORBIT_SAMPLES) * 86_400_000,
      );
      const sample = computePlanetPositions(sampleDate).find(
        (item) => item.entity.name === name,
      );
      if (!sample) continue;

      // Keep the selected-time Earth as origin. This yields the planet's
      // heliocentric orbit translated into the current Earth-relative frame.
      const vector = earthRelative(sample, earth);
      const position = physicalScenePosition(Cesium, vector, epoch);
      if (isRenderableCartesian(Cesium, position)) positions.push(position);
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
    if (!args.visible) {
      clear();
      return;
    }

    const earth = args.planets.find((item) => item.entity.name === "Earth");
    if (!earth) {
      clear();
      return;
    }

    const epoch = new Date(earth.entity.observedAt);
    const nextBodyIds = new Set<string>();
    const cameraPosition = viewer.camera?.positionWC;
    const occluder = cameraPosition
      ? new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPosition)
      : null;

    for (const planet of args.planets) {
      if (planet.entity.name === "Earth") continue;

      const vector = earthRelative(planet, earth);
      const distanceAu = Math.hypot(vector.x, vector.y, vector.z);
      const radiusKm = PLANET_RADIUS_KM[planet.entity.name];
      if (!radiusKm) continue;

      const id = `bridge:${planet.entity.id}`;
      const position = physicalScenePosition(Cesium, vector, epoch);
      if (!isRenderableCartesian(Cesium, position)) continue;
      const horizonVisible = !occluder || occluder.isPointVisible(position);
      const radiusMeters = radiusKm * 1000;
      const selected = id === args.selectedId;

      const entity: SpatialEntity = {
        ...planet.entity,
        id,
        position: {
          ...planet.entity.position,
          altitudeMeters: distanceAu * AU_METERS,
        },
        properties: {
          ...planet.entity.properties,
          physicalRadiusKm: radiusKm,
          physicalDiameterKm: radiusKm * 2,
          earthRelativeDistanceAu: Number(distanceAu.toFixed(6)),
          earthRelativeDistanceKm: Math.round(distanceAu * AU_METERS / 1000),
          displayFrame: "Earth-relative J2000 celestial context",
          bodyScale: "Physical radius in meters",
          locatorMarker: "UI locator only; not body size",
          sunRepresentation: "Native Cesium scene Sun",
        },
      };

      entityRegistry.set(id, entity);
      bodyIds.add(id);
      nextBodyIds.add(id);

      let item = viewer.entities.getById(id);
      if (!item) {
        item = viewer.entities.add({
          id,
          position,
          ellipsoid: {
            show: horizonVisible,
            radii: new Cesium.Cartesian3(radiusMeters, radiusMeters, radiusMeters),
            material: Cesium.Color.fromCssColorString(bodyColor(planet.entity.name)).withAlpha(0.96),
            outline: selected,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: selected ? 2 : 1,
          },
          point: {
            show: horizonVisible,
            pixelSize: selected ? 7 : 4,
            color: Cesium.Color.fromCssColorString(bodyColor(planet.entity.name)).withAlpha(0.62),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.78),
            outlineWidth: selected ? 2 : 1,
            disableDepthTestDistance: 0,
          },
          label: {
            show: horizonVisible,
            text: `${planet.entity.name.toUpperCase()} · LOCATOR`,
            font: '700 10px "Segoe UI", Arial, sans-serif',
            fillColor: Cesium.Color.fromCssColorString("#e2e8f0"),
            outlineColor: Cesium.Color.fromCssColorString("#020617"),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(9, -9),
            disableDepthTestDistance: 0,
          },
        });
      } else {
        item.position = new Cesium.ConstantPositionProperty(position);
        if (item.ellipsoid) {
          item.ellipsoid.show = new Cesium.ConstantProperty(horizonVisible);
          item.ellipsoid.radii = new Cesium.ConstantProperty(
            new Cesium.Cartesian3(radiusMeters, radiusMeters, radiusMeters),
          );
          item.ellipsoid.outline = new Cesium.ConstantProperty(selected);
          item.ellipsoid.outlineWidth = new Cesium.ConstantProperty(selected ? 2 : 1);
        }
        if (item.point) {
          item.point.show = new Cesium.ConstantProperty(horizonVisible);
          item.point.pixelSize = new Cesium.ConstantProperty(selected ? 7 : 4);
        }
        if (item.label) {
          item.label.show = new Cesium.ConstantProperty(horizonVisible);
        }
      }
    }

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
    }

    const wantedOrbitIds = new Set<string>();
    if (args.showOrbits) {
      for (const planet of args.planets) {
        // Earth's translated heliocentric path crosses Cartesian3.ZERO in this
        // Earth-relative bridge frame. It belongs in Space/Solar, not here.
        if (planet.entity.name === "Earth") continue;
        const periodDays = ORBIT_PERIOD_DAYS[planet.entity.name];
        if (!periodDays) continue;

        const orbitId = `bridge-orbit:${planet.entity.name.toLowerCase()}`;
        wantedOrbitIds.add(orbitId);
        const positions = orbitPositions(planet.entity.name, periodDays, earth);
        if (positions.length < 2) continue;
        const existing = viewer.entities.getById(orbitId);

        if (!existing) {
          viewer.entities.add({
            id: orbitId,
            polyline: {
              positions,
              width: planet.entity.name === "Earth" ? 1.7 : 1,
              material: Cesium.Color.fromCssColorString(
                planet.entity.name === "Earth" ? "#38bdf8" : "#94a3b8",
              ).withAlpha(planet.entity.name === "Earth" ? 0.48 : 0.25),
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
