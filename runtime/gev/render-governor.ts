type CesiumLikeViewer = {
  scene?: {
    requestRenderMode?: boolean;
    maximumRenderTimeChange?: number;
    requestRender?: () => void;
  };
};

let viewer: CesiumLikeViewer | null = null;
const holds = new Set<string>();
const recentRequests: Array<{ reason: string; at: number }> = [];
const RECENT_REQUEST_CAP = 16;

function applyMode() {
  if (!viewer?.scene) return;
  const continuous = holds.size > 0;
  viewer.scene.requestRenderMode = !continuous;
  if (!continuous) viewer.scene.requestRender?.();
}

/** GEV-derived request-on-change governor. Install only after layer renderers migrate. */
export function installRenderGovernor(nextViewer: CesiumLikeViewer) {
  viewer = nextViewer;
  if (viewer.scene) viewer.scene.maximumRenderTimeChange = Number.POSITIVE_INFINITY;
  applyMode();
}

export function holdContinuousRender(owner: string) {
  if (!owner) return;
  holds.add(owner);
  applyMode();
}

export function releaseContinuousRender(owner: string) {
  holds.delete(owner);
  applyMode();
}

export function requestRender(reason = "unspecified") {
  if (viewer?.scene && holds.size === 0) {
    recentRequests.push({ reason, at: Date.now() });
    if (recentRequests.length > RECENT_REQUEST_CAP) recentRequests.shift();
  }
  viewer?.scene?.requestRender?.();
}

export function uninstallRenderGovernor(target?: CesiumLikeViewer) {
  if (target && viewer !== target) return;
  viewer = null;
  holds.clear();
  recentRequests.length = 0;
}

export function renderGovernorDiagnostics() {
  return { installed: Boolean(viewer), mode: holds.size ? "continuous" as const : "idle" as const, holds: [...holds].sort(), recentRequests: [...recentRequests] };
}
