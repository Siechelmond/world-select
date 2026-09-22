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
  satelliteContextVisible: boolean;
  planetOrbitsAvailable: boolean;
  statusLabel: "GROUND" | "EARTH / ORBIT" | "CISLUNAR" | "SOLAR · COMPRESSED";
}>;

export const AU_METERS = 149_597_870_700;
export const GROUND_TIER_MAX_HEIGHT_M = 120_000;
export const EARTH_LAYER_CONTEXT_MAX_HEIGHT_M = 36_000_000;
export const CELESTIAL_COMPRESSION_START_M = 60_000_000;
export const CISLUNAR_CONTEXT_HEIGHT_M = 80_000_000;
export const SATELLITE_CONTEXT_MAX_HEIGHT_M = 120_000_000;
export const SOLAR_CONTEXT_HEIGHT_M = 1_200_000_000;
export const EARTH_VIEW_MAX_LOGICAL_DISTANCE_M = 100 * AU_METERS;

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
    satelliteContextVisible:
      !isGround && normalizedHeight < SATELLITE_CONTEXT_MAX_HEIGHT_M,
    planetOrbitsAvailable: isSolar,
    statusLabel: isSolar
      ? "SOLAR · COMPRESSED"
      : isCislunar
        ? "CISLUNAR"
        : isEarthOrbit
          ? "EARTH / ORBIT"
          : "GROUND",
  };
}
