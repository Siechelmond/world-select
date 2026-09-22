export type EarthScaleTier = "ground" | "earth" | "cislunar" | "solar";

export type EarthSceneState = Readonly<{
  cameraHeight: number;
  tier: EarthScaleTier;
  isGround: boolean;
  isEarthOrbit: boolean;
  isCislunar: boolean;
  isSolar: boolean;
  surfaceVisible: boolean;
  earthOrbitVisible: boolean;
  cislunarContextVisible: boolean;
  celestialContextVisible: boolean;
  solarContextVisible: boolean;
  fullSolarContextVisible: boolean;
  earthReferenceVisible: boolean;
  cislunarGuideAlpha: number;
  satelliteContextVisible: boolean;
  planetOrbitsAvailable: boolean;
  statusLabel: "GROUND" | "EARTH / ORBIT" | "CISLUNAR" | "SOLAR · COMPRESSED" | "FULL SOLAR · COMPRESSED";
}>;

export const AU_METERS = 149_597_870_700;
export const LIGHT_YEAR_METERS = 9_460_730_472_580_800;
export const GROUND_TIER_MAX_HEIGHT_M = 120_000;
export const EARTH_LAYER_CONTEXT_MAX_HEIGHT_M = 36_000_000;
export const CELESTIAL_COMPRESSION_START_M = 60_000_000;
export const CISLUNAR_CONTEXT_HEIGHT_M = 80_000_000;
export const SATELLITE_LIVE_PROPAGATION_MAX_HEIGHT_M = 120_000_000;
export const SOLAR_CONTEXT_HEIGHT_M = 1_200_000_000;
export const SOLAR_HANDOFF_DISTANCE_M = AU_METERS;
export const FULL_SOLAR_CONTEXT_DISTANCE_M = SOLAR_HANDOFF_DISTANCE_M;
export const FULL_SOLAR_EXIT_DISTANCE_M = 0.82 * AU_METERS;
export const SOLAR_DEAD_SCROLL_TICKS = 4;
export const CISLUNAR_GUIDE_FADE_START_M = 0.08 * AU_METERS;
export const EARTH_REFERENCE_MIN_DISTANCE_M = 0.1 * AU_METERS;
export const SOLAR_DISPLAY_MAX_DISTANCE_M = 30.1 * AU_METERS;
export const SOLAR_DISPLAY_RADIUS_M = 4_000_000_000;
export const CELESTIAL_NAVIGATION_MILESTONES_M = [
  AU_METERS,
  5.2 * AU_METERS,
  9.5 * AU_METERS,
  19.2 * AU_METERS,
  30.1 * AU_METERS,
  120 * AU_METERS,
  0.1 * LIGHT_YEAR_METERS,
  LIGHT_YEAR_METERS,
] as const;
// Keep the Earth/Celestial camera continuous well beyond the heliosphere.
// A later Galactic frame can hand off before this safety ceiling.
export const EARTH_VIEW_MAX_LOGICAL_DISTANCE_M = LIGHT_YEAR_METERS;

// Calibrated once for a continuous monotonic display curve:
// logical 384,400 km (Moon) -> display ~150,000 km
// logical 1 AU -> display ~5,000,000 km.
// These are display anchors only; data/provenance and DIST remain logical/true.
const CELESTIAL_LOG_REFERENCE_M = 5_041_269_009.54116;
const CELESTIAL_LOG_SCALE_M = 1_443_158_110.2225685;

export function logicalToDisplayDistanceM(logicalDistanceM: number) {
  const logical = Number.isFinite(logicalDistanceM)
    ? Math.max(0, logicalDistanceM)
    : 0;
  if (logical <= CELESTIAL_COMPRESSION_START_M) return logical;

  return CELESTIAL_COMPRESSION_START_M
    + CELESTIAL_LOG_SCALE_M
      * Math.log1p(
        (logical - CELESTIAL_COMPRESSION_START_M)
        / CELESTIAL_LOG_REFERENCE_M,
      );
}

export function displayToLogicalDistanceM(displayDistanceM: number) {
  const display = Number.isFinite(displayDistanceM)
    ? Math.max(0, displayDistanceM)
    : 0;
  if (display <= CELESTIAL_COMPRESSION_START_M) return display;

  return CELESTIAL_COMPRESSION_START_M
    + CELESTIAL_LOG_REFERENCE_M
      * Math.expm1(
        (display - CELESTIAL_COMPRESSION_START_M)
        / CELESTIAL_LOG_SCALE_M,
      );
}

export const EARTH_VIEW_MAX_DISPLAY_DISTANCE_M =
  logicalToDisplayDistanceM(EARTH_VIEW_MAX_LOGICAL_DISTANCE_M);

// Solar bodies share one heliocentric radial transform before the whole
// system is translated into the Earth-fixed Cesium frame. This preserves
// angular relationships and radial ordering; compressing each Earth-relative
// vector independently would distort the Solar-system geometry.
const SOLAR_LOG_STRENGTH = 24;

export function heliocentricToSolarDisplayDistanceM(distanceM: number) {
  const normalized = Math.max(0, distanceM) / SOLAR_DISPLAY_MAX_DISTANCE_M;
  return SOLAR_DISPLAY_RADIUS_M
    * Math.log1p(SOLAR_LOG_STRENGTH * normalized)
    / Math.log1p(SOLAR_LOG_STRENGTH);
}

export function resolveEarthScaleTier(cameraHeight: number): EarthScaleTier {
  if (!Number.isFinite(cameraHeight) || cameraHeight < GROUND_TIER_MAX_HEIGHT_M) {
    return "ground";
  }
  if (cameraHeight >= SOLAR_CONTEXT_HEIGHT_M) return "solar";
  if (cameraHeight >= CISLUNAR_CONTEXT_HEIGHT_M) return "cislunar";
  return "earth";
}

export function resolveEarthSceneState(cameraHeight: number): EarthSceneState {
  const normalizedHeight = Number.isFinite(cameraHeight)
    ? Math.max(0, cameraHeight)
    : 0;
  const tier = resolveEarthScaleTier(normalizedHeight);
  const isGround = tier === "ground";
  const isEarthOrbit = tier === "earth";
  const isCislunar = tier === "cislunar";
  const isSolar = tier === "solar";
  const cislunarContextVisible = isCislunar || isSolar;
  const fullSolarContextVisible =
    normalizedHeight >= FULL_SOLAR_CONTEXT_DISTANCE_M;
  const cislunarGuideAlpha = normalizedHeight <= CISLUNAR_GUIDE_FADE_START_M
    ? 0.28
    : normalizedHeight >= SOLAR_HANDOFF_DISTANCE_M
      ? 0
      : 0.28 * (
        1 - (
          normalizedHeight - CISLUNAR_GUIDE_FADE_START_M
        ) / (
          SOLAR_HANDOFF_DISTANCE_M - CISLUNAR_GUIDE_FADE_START_M
        )
      );

  return {
    cameraHeight: normalizedHeight,
    tier,
    isGround,
    isEarthOrbit,
    isCislunar,
    isSolar,
    surfaceVisible: normalizedHeight < EARTH_LAYER_CONTEXT_MAX_HEIGHT_M,
    earthOrbitVisible:
      !isGround && normalizedHeight < EARTH_LAYER_CONTEXT_MAX_HEIGHT_M,
    cislunarContextVisible,
    celestialContextVisible: cislunarContextVisible,
    solarContextVisible: isSolar,
    fullSolarContextVisible,
    earthReferenceVisible:
      normalizedHeight >= EARTH_REFERENCE_MIN_DISTANCE_M,
    cislunarGuideAlpha,
    // Satellite points stay as spatial context after live propagation stops.
    // Their Cesium distance scaling makes them fade/shrink naturally instead of
    // disappearing at one logical-height switch.
    satelliteContextVisible: !isGround,
    planetOrbitsAvailable: isSolar,
    statusLabel: fullSolarContextVisible
      ? "FULL SOLAR · COMPRESSED"
      : isSolar
        ? "SOLAR · COMPRESSED"
      : isCislunar
        ? "CISLUNAR"
        : isEarthOrbit
          ? "EARTH / ORBIT"
          : "GROUND",
  };
}
