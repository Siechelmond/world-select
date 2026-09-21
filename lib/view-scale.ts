export type EarthScaleTier = "ground" | "earth" | "solar";

export const GROUND_TIER_MAX_HEIGHT_M = 120_000;
export const SOLAR_CONTEXT_HEIGHT_M = 36_000_000;

export function resolveEarthScaleTier(cameraHeight: number): EarthScaleTier {
  if (!Number.isFinite(cameraHeight) || cameraHeight < GROUND_TIER_MAX_HEIGHT_M) {
    return "ground";
  }
  if (cameraHeight >= SOLAR_CONTEXT_HEIGHT_M) return "solar";
  return "earth";
}
