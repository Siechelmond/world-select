import type { SpatialEntity } from '@/lib/spatial';

export type RuntimeLayerId = 'earthquakes' | 'satellites' | 'aircraft' | 'traffic';
export type RuntimeLayerState = 'idle' | 'loading' | 'live' | 'degraded' | 'unavailable';

export type CameraView = {
  latitude: number;
  longitude: number;
  height: number;
  moving: boolean;
};

export type LayerProvenance = {
  provider: string;
  coverage?: 'regional' | 'worldwide' | 'viewport' | 'global';
  observedAt?: string | null;
  sourceAgeSeconds?: number | null;
  cached?: boolean;
  authMode?: string | null;
};

export type LayerBudgets = {
  maxMaterializedRecords: number;
  maxVisibleGlyphs: number;
  maxLabels: number;
  max3DModels: number;
  maxTrails: number;
  maxExpensiveGeometry: number;
};

export type RuntimeLayerStats = {
  id: RuntimeLayerId;
  enabled: boolean;
  state: RuntimeLayerState;
  count: number;
  visibleCount: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  provenance: LayerProvenance | null;
  budgets: LayerBudgets;
};

export type RuntimeSnapshot = {
  camera: CameraView;
  selected: SpatialEntity | null;
  hovered: SpatialEntity | null;
  hoveredScreen: { x: number; y: number } | null;
  followAircraft: boolean;
  mapSource: string;
  mapError: string | null;
  layers: Record<RuntimeLayerId, RuntimeLayerStats>;
};

export type LayerContext = {
  Cesium: any;
  viewer: any;
  requestRender: () => void;
  isSceneActive: () => boolean;
  onStatsChanged: () => void;
};

export interface RuntimeLayer {
  readonly id: RuntimeLayerId;
  init(context: LayerContext): void | Promise<void>;
  enable(): void | Promise<void>;
  disable(): void;
  retry(): void | Promise<void>;
  setSceneActive(active: boolean): void;
  onCameraChanged(view: CameraView): void;
  getStats(): RuntimeLayerStats;
  getEntity(id: string): SpatialEntity | null;
  select(id: string | null): void;
  destroy(): void;
}

export function createInitialLayerStats(id: RuntimeLayerId, budgets: LayerBudgets): RuntimeLayerStats {
  return {
    id,
    enabled: false,
    state: 'idle',
    count: 0,
    visibleCount: 0,
    lastSuccessAt: null,
    lastAttemptAt: null,
    error: null,
    provenance: null,
    budgets,
  };
}
