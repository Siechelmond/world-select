import type { LayerLoadState } from "@/lib/layer-runtime";

export type FeedState = "nominal" | "loading" | "degraded" | "stale" | "fallback" | "unavailable";

/** GEV-style truth layer: presentation derives from evidence, never from the toggle alone. */
export function layerFeedState(input: {
  status?: string | null;
  count?: number;
  lastUpdate?: number | null;
  loading?: boolean;
  stale?: boolean;
  fallback?: boolean;
  degraded?: boolean;
  available?: boolean;
  error?: unknown;
} = {}): FeedState {
  const status = String(input.status ?? "").toLowerCase();
  const hasPriorData = Number(input.count ?? 0) > 0 || Boolean(input.lastUpdate);
  if (["unavailable", "offline", "down", "error"].includes(status)) return "unavailable";
  if ((input.error || input.available === false) && !hasPriorData) return "unavailable";
  if (input.loading) return "loading";
  if (input.fallback || status === "fallback") return "fallback";
  if (input.stale || status === "stale") return "stale";
  if (input.degraded || input.error || input.available === false) return "degraded";
  return "nominal";
}

export function toLayerLoadState(state: FeedState, hasData: boolean): LayerLoadState {
  if (state === "loading") return "loading";
  if (state === "unavailable") return "error";
  if (["degraded", "stale", "fallback"].includes(state)) return hasData ? "degraded" : "error";
  return hasData ? "ready" : "idle";
}
