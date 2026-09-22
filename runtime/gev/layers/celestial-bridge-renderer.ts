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
  heliocentricToSolarDisplayDistanceM,
  logicalToDisplayDistanceM,
} from "@/lib/view-scale";

const ORBIT_SAMPLES = 96;
const MOON_ORBIT_SAMPLES = 128;
// Cislunar navigation uses a local visual orbit radius so the Earth and Moon
// can be read in one camera frame. The model still carries the true 384,400 km.
const EARTH_MOON_DISPLAY_ORBIT_M = 120_000_000;
const SOLAR_MOON_SYSTEM_MIN_RADIUS_M = 7_000_000;
const SOLAR_MOON_SYSTEM_MAX_RADIUS_M = 36_000_000;
const OBLIQUITY_J2000_RAD = 23.43928 * Math.PI / 180;
const EARTH_REFERENCE_ID = "bridge:earth:reference";
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
  return Cesium.Matrix3.multiplyByVector(
    matrix,
    vector,
    new Cesium.Cartesian3(),
  );
}

function heliocentricDisplayPosition(
  Cesium: any,
  bodyVectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const magnitudeAu = Math.hypot(
    bodyVectorAu.x,
    bodyVectorAu.y,
    bodyVectorAu.z,
  );
  if (!Number.isFinite(magnitudeAu) || magnitudeAu < 1e-12) {
    return Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO);
  }

  const equatorial = eclipticJ2000ToEquatorial(bodyVectorAu);
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
    heliocentricToSolarDisplayDistanceM(logicalDistanceM);

  return Cesium.Cartesian3.multiplyByScalar(
    normalized,
    displayDistanceM,
    new Cesium.Cartesian3(),
  );
}

function earthRelativeDisplayPosition(
  Cesium: any,
  bodyVectorAu: { x: number; y: number; z: number },
  earthVectorAu: { x: number; y: number; z: number },
  date: Date,
) {
  const bodyPosition = heliocentricDisplayPosition(
    Cesium,
    bodyVectorAu,
    date,
  );
  const earthPosition = heliocentricDisplayPosition(
    Cesium,
    earthVectorAu,
    date,
  );
  return Cesium.Cartesian3.subtract(
    bodyPosition,
    earthPosition,
    new Cesium.Cartesian3(),
  );
}

function bodyPixelSize(name: string, radiusKmOverride?: number) {
  if (name === "Moon") return 6;
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

function moonDisplayOrbitRadiusM(
  parentName: string,
  moon: MoonSpec,
  solarContext: boolean,
) {
  const trueRadiusM = moon.orbitalRadiusKm * 1_000;
  const sharedDisplayRadiusM = logicalToDisplayDistanceM(trueRadiusM);
  if (solarContext) {
    const siblings = getPlanetMoons(parentName);
    const largestOrbitKm = Math.max(
      moon.orbitalRadiusKm,
      ...siblings.map((item) => item.orbitalRadiusKm),
    );
    const ratio = Math.max(0, Math.min(1, moon.orbitalRadiusKm / largestOrbitKm));
    const normalized = Math.log1p(9 * ratio) / Math.log(10);
    return SOLAR_MOON_SYSTEM_MIN_RADIUS_M
      + (SOLAR_MOON_SYSTEM_MAX_RADIUS_M - SOLAR_MOON_SYSTEM_MIN_RADIUS_M)
        * normalized;
  }
  return parentName === "Earth" && moon.name === "Moon"
    ? Math.min(sharedDisplayRadiusM, EARTH_MOON_DISPLAY_ORBIT_M)
    : sharedDisplayRadiusM;
}

function moonLocalOffset(
  Cesium: any,
  moon: MoonSpec,
  parentName: string,
  date: Date,
  solarContext: boolean,
  phaseOverride?: number,
) {
  const radiusM = moonDisplayOrbitRadiusM(parentName, moon, solarContext);
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
  solarContext: boolean,
) {
  const positions: any[] = [];
  for (let index = 0; index <= MOON_ORBIT_SAMPLES; index += 1) {
    const phase = index / MOON_ORBIT_SAMPLES * Math.PI * 2;
    const local = moonLocalOffset(
      Cesium,
      moon,
      parentName,
      date,
      solarContext,
      phase,
    );
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
  const bodyScaleByDistance = new Cesium.NearFarScalar(
    20_000_000,
    1,
    50_000_000_000,
    0.82,
  );
  const bodyAlphaByDistance = new Cesium.NearFarScalar(
    50_000_000,
    1,
    50_000_000_000,
    0.9,
  );
  const labelAlphaByDistance = new Cesium.NearFarScalar(
    80_000_000,
    1,
    50_000_000_000,
    0.82,
  );
  const bodyIds = new Set<string>();
  const orbitIds = new Set<string>();
  const orbitCache = new Map<string, any[]>();
  let solarFrame: {
    center: any;
    radius: number;
    normal: any;
    up: any;
  } | null = null;
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
    solarFrame = null;
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
                scaleByDistance: bodyScaleByDistance,
                translucencyByDistance: bodyAlphaByDistance,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              point: {
                pixelSize: selected ? 9 : 7,
                color: Cesium.Color.fromCssColorString("#fff7c2"),
                outlineColor: Cesium.Color.fromCssColorString("#facc15"),
                outlineWidth: 2,
                scaleByDistance: bodyScaleByDistance,
                translucencyByDistance: bodyAlphaByDistance,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }
          : {
              point: {
                pixelSize: selected ? pixelSize + 4 : pixelSize,
                color,
                outlineColor: Cesium.Color.fromCssColorString("#020617"),
                outlineWidth: selected ? 3 : 1.5,
                scaleByDistance: bodyScaleByDistance,
                translucencyByDistance: bodyAlphaByDistance,
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
          translucencyByDistance: labelAlphaByDistance,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      item.position = new Cesium.ConstantPositionProperty(position);
      if (isSun && item.billboard) {
        const glowSize = selected ? 58 : 50;
        item.billboard.width = new Cesium.ConstantProperty(glowSize);
        item.billboard.height = new Cesium.ConstantProperty(glowSize);
        item.billboard.scaleByDistance =
          new Cesium.ConstantProperty(bodyScaleByDistance);
        item.billboard.translucencyByDistance =
          new Cesium.ConstantProperty(bodyAlphaByDistance);
      }
      if (item.point) {
        const nextSize = isSun ? (selected ? 9 : 7) : (selected ? pixelSize + 4 : pixelSize);
        item.point.pixelSize = new Cesium.ConstantProperty(nextSize);
        item.point.color = new Cesium.ConstantProperty(color);
        item.point.outlineWidth = new Cesium.ConstantProperty(
          isSun ? 2 : (selected ? 3 : 1.5),
        );
        item.point.scaleByDistance =
          new Cesium.ConstantProperty(bodyScaleByDistance);
        item.point.translucencyByDistance =
          new Cesium.ConstantProperty(bodyAlphaByDistance);
      }
      if (item.label) {
        item.label.show = new Cesium.ConstantProperty(showLabel || selected);
        item.label.translucencyByDistance =
          new Cesium.ConstantProperty(labelAlphaByDistance);
      }
    }
  };

  const sync = (args: {
    planets: PlanetPosition[];
    visible: boolean;
    showSolarBodies: boolean;
    solarFrameActive: boolean;
    showEarthReference: boolean;
    cislunarGuideAlpha: number;
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

    // The native Cesium globe remains the only physical Earth. This tiny
    // screen-space reference preserves Earth/Moon orientation as the globe
    // becomes sub-pixel at cislunar and Solar scales.
    const earthReference: SpatialEntity = {
      ...earth.entity,
      id: EARTH_REFERENCE_ID,
      name: "Earth",
      position: {
        ...earth.entity.position,
        altitudeMeters: 0,
      },
      properties: {
        ...earth.entity.properties,
        role: "screen-space Earth reference; native Cesium globe is the physical Earth",
        displayFrame: "Earth-centered reference origin",
      },
    };
    if (args.showEarthReference) {
      nextBodyIds.add(EARTH_REFERENCE_ID);
      syncBody({
        id: EARTH_REFERENCE_ID,
        entity: earthReference,
        position: Cesium.Cartesian3.ZERO,
        name: "Earth",
        selected: args.selectedId === EARTH_REFERENCE_ID,
        colorHex: "#38bdf8",
        showLabel: true,
      });
    }

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
      const localOffset = moonLocalOffset(
        Cesium,
        moon,
        parentName,
        epoch,
        args.solarFrameActive,
      );
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
            moonDisplayOrbitRadiusM(
              parentName,
              moon,
              args.solarFrameActive,
            ) / 1_000,
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
        // The overview keeps every moon point selectable, but moon names only
        // appear in the cislunar frame or on selection. Showing all featured
        // moon labels in the full Solar frame creates unreadable name piles.
        showLabel:
          !args.solarFrameActive && (alwaysLabel || moon.radiusKm >= 1_000),
      });
    };

    // The Earth-Moon system is the cislunar bridge between GEO and Solar.
    // Its true 384,400 km model distance stays in lib/space.ts; its rendered
    // radius comes from the same shared transform as the camera.
    const earthMoon = getPlanetMoons("Earth")[0];
    if (earthMoon) {
      syncMoonAtParent("Earth", Cesium.Cartesian3.ZERO, earthMoon, true);

      const moonOrbitPositionsNow = moonOrbitPositions(
        Cesium,
        Cesium.Cartesian3.ZERO,
        earthMoon,
        "Earth",
        epoch,
        args.solarFrameActive,
      );

      // Keep the cislunar guide through the Earth/Moon -> Solar handoff. It
      // fades only as the full-Solar frame takes ownership; the explicit orbit
      // toggle remains the sole owner of persistent Solar orbit lines.
      const guideAlpha = Math.max(0, Math.min(0.28, args.cislunarGuideAlpha));
      if (guideAlpha > 0.005) {
        const guideId = "bridge-guide:earth-moon";
        const existingGuide = viewer.entities.getById(guideId);
        const guideMaterial = Cesium.Color
          .fromCssColorString(earthMoon.color)
          .withAlpha(guideAlpha);

        if (!existingGuide) {
          viewer.entities.add({
            id: guideId,
            show: true,
            polyline: {
              positions: moonOrbitPositionsNow,
              width: 1.2,
              material: guideMaterial,
              arcType: Cesium.ArcType.NONE,
            },
          });
        } else {
          existingGuide.show = true;
          if (existingGuide.polyline) {
            existingGuide.polyline.positions =
              new Cesium.ConstantProperty(moonOrbitPositionsNow);
            existingGuide.polyline.material =
              new Cesium.ColorMaterialProperty(guideMaterial);
          }
        }
        orbitIds.add(guideId);
      }

      if (args.showOrbits && args.showSolarBodies) {
        const moonOrbitId = "bridge-orbit:earth-moon";
        const existing = viewer.entities.getById(moonOrbitId);
        const material = Cesium.Color
          .fromCssColorString(earthMoon.color)
          .withAlpha(0.42);

        if (!existing) {
          viewer.entities.add({
            id: moonOrbitId,
            show: true,
            polyline: {
              positions: moonOrbitPositionsNow,
              width: 1.4,
              material,
              arcType: Cesium.ArcType.NONE,
            },
          });
        } else {
          existing.show = true;
          if (existing.polyline) {
            existing.polyline.positions =
              new Cesium.ConstantProperty(moonOrbitPositionsNow);
            existing.polyline.material =
              new Cesium.ColorMaterialProperty(material);
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

      const solarFramePoints = [
        Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO),
        Cesium.Cartesian3.clone(sunPosition),
      ];

      for (const planet of args.planets) {
        if (planet.entity.name === "Earth") continue;

        const position = earthRelativeDisplayPosition(
          Cesium,
          { x: planet.xAu, y: planet.yAu, z: planet.zAu },
          earthVector,
          epoch,
        );
        if (!finiteCartesian(position)) continue;
        solarFramePoints.push(Cesium.Cartesian3.clone(position));

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

      const bounds = Cesium.BoundingSphere.fromPoints(solarFramePoints);
      const eclipticNorthEquatorial = eclipticJ2000ToEquatorial({
        x: 0,
        y: 0,
        z: 1,
      });
      const eclipticUpEquatorial = eclipticJ2000ToEquatorial({
        x: 0,
        y: 1,
        z: 0,
      });
      const eclipticNormal = inertialToFixed(
        Cesium,
        new Cesium.Cartesian3(
          eclipticNorthEquatorial.x,
          eclipticNorthEquatorial.y,
          eclipticNorthEquatorial.z,
        ),
        epoch,
      );
      const eclipticUp = inertialToFixed(
        Cesium,
        new Cesium.Cartesian3(
          eclipticUpEquatorial.x,
          eclipticUpEquatorial.y,
          eclipticUpEquatorial.z,
        ),
        epoch,
      );
      solarFrame = {
        center: Cesium.Cartesian3.clone(bounds.center),
        radius: bounds.radius,
        normal: Cesium.Cartesian3.normalize(
          eclipticNormal,
          new Cesium.Cartesian3(),
        ),
        up: Cesium.Cartesian3.normalize(
          eclipticUp,
          new Cesium.Cartesian3(),
        ),
      };

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
                width: planet.entity.name === "Earth" ? 2 : 1.6,
                material,
                depthFailMaterial: material,
                arcType: Cesium.ArcType.NONE,
              },
            });
          } else {
            existing.show = true;
            if (existing.polyline) {
              existing.polyline.positions = new Cesium.ConstantProperty(positions);
              existing.polyline.material = new Cesium.ColorMaterialProperty(material);
              existing.polyline.depthFailMaterial = new Cesium.ColorMaterialProperty(material);
            }
          }

          orbitIds.add(orbitId);
        }
      }
    } else {
      solarFrame = null;
      setNativeSunVisible(true);
    }

    for (const id of Array.from(bodyIds)) {
      if (!nextBodyIds.has(id)) removeBody(id);
    }

    viewer.scene?.requestRender?.();
  };

  return Object.freeze({
    sync,
    getSolarFrame() {
      if (!solarFrame) return null;
      return {
        center: Cesium.Cartesian3.clone(solarFrame.center),
        radius: solarFrame.radius,
        normal: Cesium.Cartesian3.clone(solarFrame.normal),
        up: Cesium.Cartesian3.clone(solarFrame.up),
      };
    },
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
