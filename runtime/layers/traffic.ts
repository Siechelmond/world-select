import { fetchTrafficStatus, type TrafficStatus } from '@/lib/traffic';
import type { SpatialEntity } from '@/lib/spatial';
import {
  createInitialLayerStats,
  type CameraView,
  type LayerContext,
  type RuntimeLayer,
  type RuntimeLayerStats,
} from '@/runtime/types';

const STATUS_REFRESH_MS = 120_000;
const BUDGETS = {
  maxMaterializedRecords: 0,
  maxVisibleGlyphs: 0,
  maxLabels: 0,
  max3DModels: 0,
  maxTrails: 0,
  maxExpensiveGeometry: 2,
};

export class TrafficLayer implements RuntimeLayer {
  readonly id = 'traffic' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private flowLayer: any = null;
  private incidentLayer: any = null;
  private status: TrafficStatus | null = null;
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private sceneActive = true;
  private destroyed = false;
  private tileErrorHandler: ((error: any) => void) | null = null;

  init(context: LayerContext) { this.context = context; }
  private publish() { this.context?.onStatsChanged(); }
  getProviderStatus() { return this.status; }

  private removeLayers() {
    if (!this.context) return;
    const layers = this.context.viewer.imageryLayers;
    if (this.flowLayer) layers.remove(this.flowLayer, true);
    if (this.incidentLayer) layers.remove(this.incidentLayer, true);
    this.flowLayer = null;
    this.incidentLayer = null;
    this.stats.visibleCount = 0;
  }

  private attachLayers() {
    if (!this.context || this.flowLayer || !this.stats.enabled) return;
    const { Cesium, viewer } = this.context;
    const onTileError = (error: any) => {
      if (!this.stats.enabled) return;
      const status = Number(error?.statusCode ?? 0);
      this.stats.state = 'degraded';
      this.stats.error = status
        ? `Traffic tile request failed (HTTP ${status}) · keeping loaded tiles`
        : 'Traffic tile refresh delayed · keeping loaded tiles';
      this.publish();
    };
    this.tileErrorHandler = onTileError;

    const flowProvider = new Cesium.UrlTemplateImageryProvider({
      url: '/api/traffic?z={z}&x={x}&y={y}',
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: 'Traffic © TomTom',
    });
    flowProvider.errorEvent?.addEventListener(onTileError);
    this.flowLayer = viewer.imageryLayers.addImageryProvider(flowProvider);
    this.flowLayer.alpha = 0.94;
    this.flowLayer.brightness = 1.06;
    this.flowLayer.contrast = 1.12;
    this.flowLayer.show = this.sceneActive;

    const incidentProvider = new Cesium.UrlTemplateImageryProvider({
      url: '/api/traffic?kind=incidents&z={z}&x={x}&y={y}',
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: 'Traffic incidents © TomTom',
    });
    incidentProvider.errorEvent?.addEventListener(onTileError);
    this.incidentLayer = viewer.imageryLayers.addImageryProvider(incidentProvider);
    this.incidentLayer.alpha = 0.68;
    this.incidentLayer.show = this.sceneActive;
    this.stats.visibleCount = 2;
    this.context.requestRender();
  }

  private schedule() {
    if (this.timer != null) window.clearTimeout(this.timer);
    if (!this.stats.enabled || this.destroyed) return;
    this.timer = window.setTimeout(() => void this.refresh(false), STATUS_REFRESH_MS);
  }

  private async refresh(initial: boolean) {
    if (!this.context || !this.stats.enabled || this.destroyed) return;
    this.controller?.abort();
    this.controller = new AbortController();
    this.stats.lastAttemptAt = new Date().toISOString();
    if (initial && !this.flowLayer) this.stats.state = 'loading';
    this.stats.error = null;
    this.publish();
    try {
      const status = await fetchTrafficStatus(this.controller.signal);
      if (this.destroyed || !this.stats.enabled) return;
      this.status = status;
      if (!status.configured) throw new Error(status.message || 'Traffic source not configured');

      // A status probe is only one tile. If the key is configured but that probe
      // is temporarily rejected or slow, still attach the viewport-driven tile
      // providers: Cesium can then request the tiles the user actually sees. Tile
      // failures are isolated by onTileError and never replace the basemap.
      this.attachLayers();
      this.stats.state = status.available ? 'live' : 'degraded';
      this.stats.count = 0;
      this.stats.lastSuccessAt = status.available ? new Date().toISOString() : this.stats.lastSuccessAt;
      this.stats.provenance = {
        provider: status.provider,
        coverage: 'viewport',
        observedAt: this.stats.lastSuccessAt,
        cached: true,
      };
      this.stats.error = status.available ? null : `${status.message || 'Traffic probe unavailable'} · validating with visible tiles`;
    } catch (reason: unknown) {
      if (this.controller?.signal.aborted || this.destroyed) return;
      const message = reason instanceof Error ? reason.message : 'Traffic status failed';
      this.stats.state = this.flowLayer ? 'degraded' : 'unavailable';
      this.stats.error = this.flowLayer ? `${message} · keeping loaded traffic tiles` : message;
    } finally {
      this.publish();
      this.schedule();
    }
  }

  async enable() {
    this.stats.enabled = true;
    if (this.flowLayer) this.flowLayer.show = this.sceneActive;
    if (this.incidentLayer) this.incidentLayer.show = this.sceneActive;
    this.publish();
    await this.refresh(!this.flowLayer);
  }

  disable() {
    this.stats.enabled = false;
    this.stats.state = 'idle';
    this.controller?.abort();
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    this.removeLayers();
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.flowLayer); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.flowLayer) this.flowLayer.show = active && this.stats.enabled;
    if (this.incidentLayer) this.incidentLayer.show = active && this.stats.enabled;
    this.context?.requestRender();
  }

  onCameraChanged(_view: CameraView) {
    // Cesium's imagery provider is viewport-driven: only visible z/x/y traffic tiles are requested.
  }

  getStats() { return { ...this.stats, provenance: this.stats.provenance ? { ...this.stats.provenance } : null }; }
  getEntity(_id: string): SpatialEntity | null { return null; }
  select(_id: string | null) {}

  destroy() {
    this.destroyed = true;
    this.disable();
    this.context = null;
  }
}
