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

export const GROUND_TIER_MAX_HEIGHT_M = 120_000;
export const EARTH_LAYER_CONTEXT_MAX_HEIGHT_M = 36_000_000;
export const CISLUNAR_CONTEXT_HEIGHT_M = 80_000_000;
export const SATELLITE_CONTEXT_MAX_HEIGHT_M = 120_000_000;
export const SOLAR_CONTEXT_HEIGHT_M = 1_200_000_000;

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
