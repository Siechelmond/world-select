import type { SpatialEntity } from "@/lib/spatial";
import {
  computePlanetPositions,
  getPlanetMoons,
  moonEntity,
  type MoonSpec,
  type PlanetPosition,
} from "@/lib/space";
import {
  AU_METERS,
  logicalToDisplayDistanceM,
} from "@/lib/view-scale";

const ORBIT_SAMPLES = 96;
const MOON_ORBIT_SAMPLES = 128;
const OBLIQUITY_J2000_RAD = 23.43928 * Math.PI / 180;
const SUN_ID = "bridge:solar:sun";
const SUN_GLOW_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <defs>
      <radialGradient id="g">
        <stop offset="0%" stop-color="#fffdf0" stop-opacity="1"/>
        <stop offset="18%" stop-color="#fff7b2" stop-opacity="1"/>
        <stop offset="38%" stop-color="#fde047" stop-opacity=".92"/>
        <stop offset="62%" stop-color="#f59e0b" stop-opacity=".34"/>
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="64" cy="64" r="62" fill="url(#g)"/>
    <circle cx="64" cy="64" r="18" fill="#fff7c2"/>
  </svg>
`)}`;

const BODY_RADIUS_KM: Record<string, number> = {
  Sun: 696_340,
  Mercury: 2_439.7,
  Venus: 6_051.8,
  Earth: 6_371,
  Moon: 1_737.4,
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

function earthRelativeDisplayPosition(
  Cesium: any,
  bodyVectorAu: { x: number; y: number; z: number },
  earthVectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const relativeAu = {
    x: bodyVectorAu.x - earthVectorAu.x,
    y: bodyVectorAu.y - earthVectorAu.y,
    z: bodyVectorAu.z - earthVectorAu.z,
  };
  const magnitudeAu = Math.hypot(
    relativeAu.x,
    relativeAu.y,
    relativeAu.z,
  );
  if (!Number.isFinite(magnitudeAu) || magnitudeAu < 1e-12) {
    return Cesium.Cartesian3.ZERO;
  }

  const equatorial = eclipticJ2000ToEquatorial(relativeAu);
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
  const logicalDistanceM = magnitudeAu * AU_METERS;
  const displayDistanceM =
    logicalToDisplayDistanceM(logicalDistanceM);

  return Cesium.Cartesian3.multiplyByScalar(
    normalized,
    displayDistanceM,
    new Cesium.Cartesian3(),
  );
}

function bodyPixelSize(name: string, radiusKmOverride?: number) {
  const earthRadiusKm = BODY_RADIUS_KM.Earth;
  const radiusKm = radiusKmOverride ?? BODY_RADIUS_KM[name] ?? earthRadiusKm;
  const compressed = 5.5 * Math.pow(radiusKm / earthRadiusKm, 0.25);
  return Math.max(3.5, Math.min(19, compressed));
}

function bodyColor(name: string) {
  return name === "Earth" ? "#38bdf8"
    : name === "Moon" ? "#d6d3d1"
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

function phaseSeedRadians(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 360) * Math.PI / 180;
}

function moonLocalOffset(
  Cesium: any,
  moon: MoonSpec,
  parentName: string,
  date: Date,
  phaseOverride?: number,
) {
  const trueRadiusM = moon.orbitalRadiusKm * 1_000;
  const radiusM = logicalToDisplayDistanceM(trueRadiusM);
  const elapsedDays = date.getTime() / 86_400_000;
  const phase = phaseOverride ?? (
    elapsedDays / moon.orbitalPeriodDays * Math.PI * 2
    + phaseSeedRadians(`${parentName}:${moon.name}`)
  );
  const inclinationDeg = parentName === "Earth" && moon.name === "Moon"
    ? 5.145
    : 2 + ((phaseSeedRadians(parentName) * 180 / Math.PI) % 7);
  const inclination = inclinationDeg * Math.PI / 180;
  const inertial = new Cesium.Cartesian3(
    Math.cos(phase) * radiusM,
    Math.sin(phase) * radiusM * Math.cos(inclination),
    Math.sin(phase) * radiusM * Math.sin(inclination),
  );
  return inertialToFixed(Cesium, inertial, date);
}

function moonOrbitPositions(
  Cesium: any,
  parentPosition: any,
  moon: MoonSpec,
  parentName: string,
  date: Date,
) {
  const positions: any[] = [];
  for (let index = 0; index <= MOON_ORBIT_SAMPLES; index += 1) {
    const phase = index / MOON_ORBIT_SAMPLES * Math.PI * 2;
    const local = moonLocalOffset(Cesium, moon, parentName, date, phase);
    positions.push(
      Cesium.Cartesian3.add(parentPosition, local, new Cesium.Cartesian3()),
    );
  }
  return positions;
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
  let orbitEpochKey: string | null = null;
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
    const key = `${epoch.getTime()}:${name}`;
    const cached = orbitCache.get(key);
    if (cached) return cached;

    const earthVector = { x: earth.xAu, y: earth.yAu, z: earth.zAu };
    const positions: any[] = [];

    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const sampleDate = new Date(
        epoch.getTime() + periodDays * (index / ORBIT_SAMPLES) * 86_400_000,
      );
      const sample = computePlanetPositions(sampleDate).find(
        (item) => item.entity.name === name,
      );
      if (!sample) continue;

      // Keep every orbit sample in the same Earth-relative display contract
      // used by the camera and body positions. The current Earth remains origin.
      const position = earthRelativeDisplayPosition(
        Cesium,
        { x: sample.xAu, y: sample.yAu, z: sample.zAu },
        earthVector,
        epoch,
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
    radiusKm?: number;
    colorHex?: string;
    showLabel?: boolean;
  }) => {
    const {
      id,
      entity,
      position,
      name,
      selected,
      isSun = false,
      radiusKm,
      colorHex,
      showLabel = true,
    } = args;
    if (!finiteCartesian(position)) return;

    entityRegistry.set(id, entity);
    bodyIds.add(id);
    const pixelSize = bodyPixelSize(isSun ? "Sun" : name, radiusKm);
    const color = Cesium.Color.fromCssColorString(
      colorHex ?? (isSun ? "#fde047" : bodyColor(name)),
    );

    let item = viewer.entities.getById(id);
    if (!item) {
      item = viewer.entities.add({
        id,
        position,
        ...(isSun
          ? {
              billboard: {
                image: SUN_GLOW_IMAGE,
                width: selected ? 58 : 50,
                height: selected ? 58 : 50,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              point: {
                pixelSize: selected ? 9 : 7,
                color: Cesium.Color.fromCssColorString("#fff7c2"),
                outlineColor: Cesium.Color.fromCssColorString("#facc15"),
                outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }
          : {
              point: {
                pixelSize: selected ? pixelSize + 4 : pixelSize,
                color,
                outlineColor: Cesium.Color.fromCssColorString("#020617"),
                outlineWidth: selected ? 3 : 1.5,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }),
        label: {
          show: showLabel || selected,
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
      if (isSun && item.billboard) {
        const glowSize = selected ? 58 : 50;
        item.billboard.width = new Cesium.ConstantProperty(glowSize);
        item.billboard.height = new Cesium.ConstantProperty(glowSize);
      }
      if (item.point) {
        const nextSize = isSun ? (selected ? 9 : 7) : (selected ? pixelSize + 4 : pixelSize);
        item.point.pixelSize = new Cesium.ConstantProperty(nextSize);
        item.point.color = new Cesium.ConstantProperty(color);
        item.point.outlineWidth = new Cesium.ConstantProperty(
          isSun ? 2 : (selected ? 3 : 1.5),
        );
      }
      if (item.label) {
        item.label.show = new Cesium.ConstantProperty(showLabel || selected);
      }
    }
  };

  const sync = (args: {
    planets: PlanetPosition[];
    visible: boolean;
    showSolarBodies: boolean;
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
    const epochKey = earth.entity.observedAt;
    if (orbitEpochKey !== epochKey) {
      orbitCache.clear();
      orbitEpochKey = epochKey;
    }

    const earthVector = { x: earth.xAu, y: earth.yAu, z: earth.zAu };
    const nextBodyIds = new Set<string>();

    // Orbit geometry is persistent once created. The UI checkbox changes only
    // visibility; it never moves bodies or rebuilds/removes orbit entities.
    for (const id of orbitIds) {
      const orbit = viewer.entities.getById(id);
      if (orbit) orbit.show = false;
    }

    const syncMoonAtParent = (
      parentName: string,
      parentPosition: any,
      moon: MoonSpec,
      alwaysLabel = false,
    ) => {
      const base = moonEntity(parentName, moon, epoch);
      const id = `bridge:${base.id}`;
      const localOffset = moonLocalOffset(Cesium, moon, parentName, epoch);
      const position = Cesium.Cartesian3.add(
        parentPosition,
        localOffset,
        new Cesium.Cartesian3(),
      );
      if (!finiteCartesian(position)) return;

      const displayDistanceM = Cesium.Cartesian3.magnitude(position);
      const entity: SpatialEntity = {
        ...base,
        id,
        position: {
          ...base.position,
          altitudeMeters: displayDistanceM,
        },
        properties: {
          ...base.properties,
          displayFrame: parentName === "Earth"
            ? "Earth-centered cislunar reference"
            : "Parent-relative moon orbit inside compressed solar context",
          trueOrbitalRadiusKm: moon.orbitalRadiusKm,
          displayOrbitalRadiusKm: Math.round(
            logicalToDisplayDistanceM(moon.orbitalRadiusKm * 1_000) / 1_000,
          ),
          displayDistanceKm: Math.round(displayDistanceM / 1_000),
          parentDisplayDistanceKm: Math.round(
            Cesium.Cartesian3.magnitude(parentPosition) / 1_000,
          ),
        },
      };

      nextBodyIds.add(id);
      syncBody({
        id,
        entity,
        position,
        name: moon.name,
        selected: args.selectedId === id,
        radiusKm: moon.radiusKm,
        colorHex: moon.color,
        showLabel: alwaysLabel || moon.radiusKm >= 1_000,
      });
    };

    // The Earth-Moon system is the cislunar bridge between GEO and Solar.
    // Its true 384,400 km model distance stays in lib/space.ts; its rendered
    // radius comes from the same shared transform as the camera.
    const earthMoon = getPlanetMoons("Earth")[0];
    if (earthMoon) {
      syncMoonAtParent("Earth", Cesium.Cartesian3.ZERO, earthMoon, true);

      if (args.showOrbits && args.showSolarBodies) {
        const moonOrbitId = "bridge-orbit:earth-moon";
        const positions = moonOrbitPositions(
          Cesium,
          Cesium.Cartesian3.ZERO,
          earthMoon,
          "Earth",
          epoch,
        );
        const existing = viewer.entities.getById(moonOrbitId);
        const material = Cesium.Color
          .fromCssColorString(earthMoon.color)
          .withAlpha(0.42);

        if (!existing) {
          viewer.entities.add({
            id: moonOrbitId,
            show: true,
            polyline: {
              positions,
              width: 1.4,
              material,
              arcType: Cesium.ArcType.NONE,
            },
          });
        } else {
          existing.show = true;
          if (existing.polyline) {
            existing.polyline.positions = new Cesium.ConstantProperty(positions);
            existing.polyline.material = new Cesium.ColorMaterialProperty(material);
          }
        }
        orbitIds.add(moonOrbitId);
      }
    }

    if (args.showSolarBodies) {
      // The native Cesium Sun is an astronomical scene primitive at true sky
      // direction. In the compressed bridge it would become a second, unrelated
      // reference, so the bridge owns one explicit compressed Sun instead.
      setNativeSunVisible(false);

      const sunPosition = earthRelativeDisplayPosition(
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
          visualScale: "Shared logical-to-display distance contract",
          displayDistanceKm: Math.round(sunDistanceM / 1_000),
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

      for (const planet of args.planets) {
        if (planet.entity.name === "Earth") continue;

        const position = earthRelativeDisplayPosition(
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
            visualScale: "Shared logical-to-display distance contract",
            displayDistanceKm: Math.round(displayDistanceM / 1_000),
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

        for (const moon of getPlanetMoons(planet.entity.name)) {
          syncMoonAtParent(planet.entity.name, position, moon);
        }
      }

      if (args.showOrbits) {
        for (const planet of args.planets) {
          const periodDays = ORBIT_PERIOD_DAYS[planet.entity.name];
          if (!periodDays) continue;

          const positions = orbitPositions(planet.entity.name, periodDays, earth);
          if (positions.length < 2) continue;

          const orbitId = `bridge-orbit:${planet.entity.name.toLowerCase()}`;
          const existing = viewer.entities.getById(orbitId);
          const material = Cesium.Color
            .fromCssColorString(bodyColor(planet.entity.name))
            .withAlpha(0.42);

          if (!existing) {
            viewer.entities.add({
              id: orbitId,
              show: true,
              polyline: {
                positions,
                width: planet.entity.name === "Earth" ? 1.8 : 1.4,
                material,
                arcType: Cesium.ArcType.NONE,
              },
            });
          } else {
            existing.show = true;
            if (existing.polyline) {
              existing.polyline.positions = new Cesium.ConstantProperty(positions);
              existing.polyline.material = new Cesium.ColorMaterialProperty(material);
            }
          }

          orbitIds.add(orbitId);
        }
      }
    } else {
      setNativeSunVisible(true);
    }

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
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
      orbitEpochKey = null;
      destroyed = true;
    },
  });
}
