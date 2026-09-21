import type { SpatialEntity } from "@/lib/spatial";
import { computePlanetPositions, type PlanetPosition } from "@/lib/space";
import {
  SOLAR_CONTEXT_HEIGHT_M,
  SOLAR_GLOBE_HANDOFF_HEIGHT_M,
} from "@/lib/view-scale";
const SOLAR_DISPLAY_ONE_AU_M = 95_000_000;
const SOLAR_DISPLAY_CURVE = 1.7;
const ORBIT_SAMPLES = 96;
const OBLIQUITY_J2000_RAD = 23.43928 * Math.PI / 180;
const SUN_ID = "bridge:solar:sun";
const EARTH_PROXY_ID = "bridge:jpl:earth";
const EARTH_PROXY_EPSILON_M = 1_000;

const BODY_RADIUS_KM: Record<string, number> = {
  Sun: 696_340,
  Mercury: 2_439.7,
  Venus: 6_051.8,
  Earth: 6_371,
  Mars: 3_389.5,
  Jupiter: 69_911,
  Saturn: 58_232,
  Uranus: 25_362,
  Neptune: 24_622,
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

function compressedRadiusMeters(distanceAu: number) {
  if (!Number.isFinite(distanceAu) || distanceAu <= 0) return 0;
  return SOLAR_DISPLAY_ONE_AU_M
    * Math.log1p(SOLAR_DISPLAY_CURVE * distanceAu)
    / Math.log1p(SOLAR_DISPLAY_CURVE);
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

function compressedHeliocentricPosition(
  Cesium: any,
  vectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const magnitudeAu = Math.hypot(vectorAu.x, vectorAu.y, vectorAu.z);
  if (!Number.isFinite(magnitudeAu) || magnitudeAu < 1e-10) {
    return Cesium.Cartesian3.ZERO;
  }

  const equatorial = eclipticJ2000ToEquatorial(vectorAu);
  const inertialDirection = new Cesium.Cartesian3(
    equatorial.x / magnitudeAu,
    equatorial.y / magnitudeAu,
    equatorial.z / magnitudeAu,
  );
  const fixedDirection = inertialToFixed(Cesium, inertialDirection, date);
  const normalized = Cesium.Cartesian3.normalize(
    fixedDirection,
    new Cesium.Cartesian3(),
  );

  return Cesium.Cartesian3.multiplyByScalar(
    normalized,
    compressedRadiusMeters(magnitudeAu),
    new Cesium.Cartesian3(),
  );
}

function earthCenteredPosition(
  Cesium: any,
  bodyVectorAu: { x: number; y: number; z: number },
  earthVectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const body = compressedHeliocentricPosition(Cesium, bodyVectorAu, date);
  const earth = compressedHeliocentricPosition(Cesium, earthVectorAu, date);
  return Cesium.Cartesian3.subtract(body, earth, new Cesium.Cartesian3());
}

function bodyPixelSize(name: string) {
  const earthRadiusKm = BODY_RADIUS_KM.Earth;
  const radiusKm = BODY_RADIUS_KM[name] ?? earthRadiusKm;
  const compressed = 5.5 * Math.pow(radiusKm / earthRadiusKm, 0.25);
  return Math.max(3.5, Math.min(19, compressed));
}

function bodyColor(name: string) {
  return name === "Earth" ? "#38bdf8"
    : name === "Mercury" ? "#cbd5e1"
      : name === "Venus" ? "#facc15"
      : name === "Mars" ? "#fb923c"
        : name === "Jupiter" ? "#d6b38a"
          : name === "Saturn" ? "#fde68a"
            : name === "Uranus" ? "#67e8f9"
              : name === "Neptune" ? "#818cf8"
                : "#cbd5e1";
}

function finiteCartesian(position: any) {
  return position
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z);
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

  const setNativeSunVisible = (visible: boolean) => {
    if (viewer.scene?.sun) viewer.scene.sun.show = visible;
  };

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
    setNativeSunVisible(true);
    viewer.scene?.requestRender?.();
  };

  const orbitPositions = (
    name: string,
    periodDays: number,
    earth: PlanetPosition,
  ) => {
    const epoch = new Date(earth.entity.observedAt);
    const hourKey = Math.floor(epoch.getTime() / 3_600_000);
    const key = `${hourKey}:${name}`;
    const cached = orbitCache.get(key);
    if (cached) return cached;

    const earthVector = { x: earth.xAu, y: earth.yAu, z: earth.zAu };
    const earthDisplay = compressedHeliocentricPosition(Cesium, earthVector, epoch);
    const positions: any[] = [];

    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const sampleDate = new Date(
        epoch.getTime() + periodDays * (index / ORBIT_SAMPLES) * 86_400_000,
      );
      const sample = computePlanetPositions(sampleDate).find(
        (item) => item.entity.name === name,
      );
      if (!sample) continue;

      // Keep all paths in one selected-time fixed frame. The heliocentric
      // radius is logarithmically compressed first, then translated so the
      // current Earth remains the origin of the bridge.
      const sampleDisplay = compressedHeliocentricPosition(
        Cesium,
        { x: sample.xAu, y: sample.yAu, z: sample.zAu },
        epoch,
      );
      const position = Cesium.Cartesian3.subtract(
        sampleDisplay,
        earthDisplay,
        new Cesium.Cartesian3(),
      );
      if (finiteCartesian(position) && Cesium.Cartesian3.magnitude(position) > 1) {
        positions.push(position);
      }
    }

    orbitCache.set(key, positions);
    return positions;
  };

  const syncBody = (args: {
    id: string;
    entity: SpatialEntity;
    position: any;
    name: string;
    selected: boolean;
    isSun?: boolean;
  }) => {
    const { id, entity, position, name, selected, isSun = false } = args;
    if (!finiteCartesian(position)) return;

    entityRegistry.set(id, entity);
    bodyIds.add(id);
    const pixelSize = bodyPixelSize(isSun ? "Sun" : name);
    const color = Cesium.Color.fromCssColorString(isSun ? "#fde047" : bodyColor(name));

    let item = viewer.entities.getById(id);
    if (!item) {
      item = viewer.entities.add({
        id,
        position,
        point: {
          pixelSize: selected ? pixelSize + 4 : pixelSize,
          color,
          outlineColor: Cesium.Color.fromCssColorString("#020617"),
          outlineWidth: selected ? 3 : 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: isSun ? "SUN · REF" : name.toUpperCase(),
          font: isSun
            ? '800 11px "Segoe UI", Arial, sans-serif'
            : '700 11px "Segoe UI", Arial, sans-serif',
          fillColor: isSun
            ? Cesium.Color.fromCssColorString("#fef08a")
            : Cesium.Color.fromCssColorString("#e2e8f0"),
          outlineColor: Cesium.Color.fromCssColorString("#020617"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(10, -10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      item.position = new Cesium.ConstantPositionProperty(position);
      if (item.point) {
        item.point.pixelSize = new Cesium.ConstantProperty(
          selected ? pixelSize + 4 : pixelSize,
        );
        item.point.outlineWidth = new Cesium.ConstantProperty(selected ? 3 : 1.5);
      }
    }
  };

  const sync = (args: {
    planets: PlanetPosition[];
    visible: boolean;
    cameraHeight: number;
    selectedId?: string | null;
    showOrbits?: boolean;
  }) => {
    if (destroyed || viewer.isDestroyed?.()) return;

    if (!args.visible || args.cameraHeight < SOLAR_CONTEXT_HEIGHT_M) {
      clear();
      return;
    }

    const earth = args.planets.find((item) => item.entity.name === "Earth");
    if (!earth) {
      clear();
      return;
    }

    // The native Cesium Sun is an astronomical scene primitive at true sky
    // direction. In the compressed bridge it would become a second, unrelated
    // reference, so the bridge owns one explicit compressed Sun instead.
    setNativeSunVisible(false);

    const epoch = new Date(earth.entity.observedAt);
    const earthVector = { x: earth.xAu, y: earth.yAu, z: earth.zAu };
    const nextBodyIds = new Set<string>();

    const sunPosition = earthCenteredPosition(
      Cesium,
      { x: 0, y: 0, z: 0 },
      earthVector,
      epoch,
    );
    const sunDistanceM = Cesium.Cartesian3.magnitude(sunPosition);
    const sunEntity: SpatialEntity = {
      id: SUN_ID,
      kind: "celestial-body",
      name: "Sun",
      position: { longitude: 0, latitude: 0, altitudeMeters: sunDistanceM },
      observedAt: earth.entity.observedAt,
      dataState: "CALCULATED",
      source: {
        id: "jpl-approx",
        label: "NASA/JPL Solar System Dynamics",
        url: "https://ssd.jpl.nasa.gov/planets/approx_pos.html",
      },
      properties: {
        role: "compressed solar reference",
        displayFrame: "Earth-centered compressed heliocentric J2000 context",
        visualScale: "Fixed logarithmic AU distance scale",
        displayDistanceKm: Math.round(sunDistanceM / 1000),
      },
    };
    nextBodyIds.add(SUN_ID);
    syncBody({
      id: SUN_ID,
      entity: sunEntity,
      position: sunPosition,
      name: "Sun",
      selected: args.selectedId === SUN_ID,
      isSun: true,
    });

    if (args.cameraHeight >= SOLAR_GLOBE_HANDOFF_HEIGHT_M) {
      const awayFromSun = Cesium.Cartesian3.negate(
        sunPosition,
        new Cesium.Cartesian3(),
      );
      const earthProxyPosition = Cesium.Cartesian3.multiplyByScalar(
        Cesium.Cartesian3.normalize(awayFromSun, new Cesium.Cartesian3()),
        EARTH_PROXY_EPSILON_M,
        new Cesium.Cartesian3(),
      );
      const earthProxyEntity: SpatialEntity = {
        ...earth.entity,
        id: EARTH_PROXY_ID,
        properties: {
          ...earth.entity.properties,
          role: "solar Earth proxy",
          displayFrame: "Earth-centered compressed heliocentric J2000 context",
          visualScale: "Body radius relation compressed separately from orbital distance",
          sunRepresentation: "World Select compressed solar reference",
        },
      };
      nextBodyIds.add(EARTH_PROXY_ID);
      syncBody({
        id: EARTH_PROXY_ID,
        entity: earthProxyEntity,
        position: earthProxyPosition,
        name: "Earth",
        selected: args.selectedId === EARTH_PROXY_ID,
      });
    }

    for (const planet of args.planets) {
      if (planet.entity.name === "Earth") continue;

      const position = earthCenteredPosition(
        Cesium,
        { x: planet.xAu, y: planet.yAu, z: planet.zAu },
        earthVector,
        epoch,
      );
      if (!finiteCartesian(position)) continue;

      const id = `bridge:${planet.entity.id}`;
      const displayDistanceM = Cesium.Cartesian3.magnitude(position);
      const entity: SpatialEntity = {
        ...planet.entity,
        id,
        position: {
          ...planet.entity.position,
          altitudeMeters: displayDistanceM,
        },
        properties: {
          ...planet.entity.properties,
          earthRelativeDistanceAu: Number(
            Math.hypot(
              planet.xAu - earth.xAu,
              planet.yAu - earth.yAu,
              planet.zAu - earth.zAu,
            ).toFixed(4),
          ),
          displayFrame: "Earth-centered compressed heliocentric J2000 context",
          visualScale: "Fixed logarithmic AU distance scale",
          displayDistanceKm: Math.round(displayDistanceM / 1000),
          sunRepresentation: "World Select compressed solar reference",
        },
      };

      nextBodyIds.add(id);
      syncBody({
        id,
        entity,
        position,
        name: planet.entity.name,
        selected: args.selectedId === id,
      });
    }

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
    }

    const wantedOrbitIds = new Set<string>();
    if (args.showOrbits) {
      for (const planet of args.planets) {
        const periodDays = ORBIT_PERIOD_DAYS[planet.entity.name];
        if (!periodDays) continue;

        const positions = orbitPositions(planet.entity.name, periodDays, earth);
        if (positions.length < 2) continue;

        const orbitId = `bridge-orbit:${planet.entity.name.toLowerCase()}`;
        wantedOrbitIds.add(orbitId);
        const existing = viewer.entities.getById(orbitId);
        const material = Cesium.Color
          .fromCssColorString(bodyColor(planet.entity.name))
          .withAlpha(0.22);

        if (!existing) {
          viewer.entities.add({
            id: orbitId,
            polyline: {
              positions,
              width: planet.entity.name === "Earth" ? 1.6 : 1,
              material,
              arcType: Cesium.ArcType.NONE,
            },
          });
        } else if (existing.polyline) {
          existing.polyline.positions = new Cesium.ConstantProperty(positions);
          existing.polyline.material = new Cesium.ColorMaterialProperty(material);
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
