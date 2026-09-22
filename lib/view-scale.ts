export type EarthScaleTier = "ground" | "earth" | "solar";

export type EarthSceneState = Readonly<{
  cameraHeight: number;
  tier: EarthScaleTier;
  isGround: boolean;
  isEarthOrbit: boolean;
  isSolar: boolean;
  surfaceVisible: boolean;
  earthOrbitVisible: boolean;
  solarContextVisible: boolean;
  satelliteContextVisible: boolean;
  planetOrbitsAvailable: boolean;
  statusLabel: "GROUND" | "EARTH / ORBIT" | "SOLAR · COMPRESSED";
}>;

export const GROUND_TIER_MAX_HEIGHT_M = 120_000;
export const SOLAR_CONTEXT_HEIGHT_M = 36_000_000;
export const SATELLITE_CONTEXT_MAX_HEIGHT_M = 120_000_000;

export function resolveEarthScaleTier(cameraHeight: number): EarthScaleTier {
  if (!Number.isFinite(cameraHeight) || cameraHeight < GROUND_TIER_MAX_HEIGHT_M) {
    return "ground";
  }
  if (cameraHeight >= SOLAR_CONTEXT_HEIGHT_M) return "solar";
  return "earth";
}

export function resolveEarthSceneState(cameraHeight: number): EarthSceneState {
  const normalizedHeight = Number.isFinite(cameraHeight)
    ? Math.max(0, cameraHeight)
    : 0;
  const tier = resolveEarthScaleTier(normalizedHeight);
  const isGround = tier === "ground";
  const isEarthOrbit = tier === "earth";
  const isSolar = tier === "solar";

  return {
    cameraHeight: normalizedHeight,
    tier,
    isGround,
    isEarthOrbit,
    isSolar,
    surfaceVisible: !isSolar,
    earthOrbitVisible: isEarthOrbit,
    solarContextVisible: isSolar,
    satelliteContextVisible:
      !isGround && normalizedHeight < SATELLITE_CONTEXT_MAX_HEIGHT_M,
    planetOrbitsAvailable: isSolar,
    statusLabel: isSolar
      ? "SOLAR · COMPRESSED"
      : isEarthOrbit
        ? "EARTH / ORBIT"
        : "GROUND",
  };
}
