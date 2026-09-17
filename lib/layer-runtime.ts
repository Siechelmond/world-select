export type LayerLoadState = "idle" | "loading" | "ready" | "degraded" | "error";

export function resolveLayerState(input: {
  enabled: boolean;
  loading?: boolean;
  hasData: boolean;
  stale?: boolean;
  failed?: boolean;
}): LayerLoadState {
  if (!input.enabled) return "idle";
  if (input.loading && !input.hasData) return "loading";
  if (input.hasData && (input.stale || input.failed)) return "degraded";
  if (input.hasData) return "ready";
  if (input.failed) return "error";
  return "loading";
}
