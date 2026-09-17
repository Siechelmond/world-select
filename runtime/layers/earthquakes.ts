import { fetchEarthquakes } from '@/lib/usgs';
import type { SpatialEntity } from '@/lib/spatial';
import {
  createInitialLayerStats,
  type CameraView,
  type LayerContext,
  type RuntimeLayer,
  type RuntimeLayerStats,
} from '@/runtime/types';

const REFRESH_MS = 60_000;
const BUDGETS = {
  maxMaterializedRecords: 5000,
  maxVisibleGlyphs: 2500,
  maxLabels: 0,
  max3DModels: 0,
  maxTrails: 0,
  maxExpensiveGeometry: 0,
};

export class EarthquakeLayer implements RuntimeLayer {
  readonly id = 'earthquakes' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private collection: any = null;
  private records = new Map<string, SpatialEntity>();
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private sceneActive = true;
  private destroyed = false;

  init(context: LayerContext) {
    this.context = context;
    this.collection = context.viewer.scene.primitives.add(new context.Cesium.PointPrimitiveCollection());
    this.collection.show = false;
  }

  private publish() {
    this.context?.onStatsChanged();
  }

  private validate(items: SpatialEntity[]) {
    if (!Array.isArray(items)) throw new Error('USGS payload is not an array');
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'earthquake' || seen.has(item.id)) throw new Error('Malformed or duplicate earthquake record');
      seen.add(item.id);
      const magnitude = Number(item.properties.magnitude);
      if (!Number.isFinite(magnitude) || magnitude < 2.5) throw new Error('Malformed earthquake magnitude');
      if (![item.position.latitude, item.position.longitude].every(Number.isFinite)) throw new Error('Malformed earthquake position');
    }
  }

  private renderSnapshot(items: SpatialEntity[]) {
    if (!this.context || !this.collection) return;
    const { Cesium } = this.context;
    this.collection.removeAll();
    this.records.clear();
    for (const item of items) this.records.set(item.id, item);
    const visible = items.slice(0, BUDGETS.maxVisibleGlyphs);
    for (const item of visible) {
      const magnitude = Number(item.properties.magnitude);
      this.collection.add({
        id: item,
        position: Cesium.Cartesian3.fromDegrees(item.position.longitude, item.position.latitude, 0),
        pixelSize: Math.max(7, Math.min(20, 5 + magnitude * 2)),
        color: Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.92),
        outlineColor: Cesium.Color.fromCssColorString('#fff7ed'),
        outlineWidth: 1,
        disableDepthTestDistance: 1_000_000,
      });
    }
    this.collection.show = this.stats.enabled && this.sceneActive;
    this.stats.count = items.length;
    this.stats.visibleCount = visible.length;
    this.context.requestRender();
  }

  private schedule() {
    if (this.timer != null) window.clearTimeout(this.timer);
    if (!this.stats.enabled || this.destroyed) return;
    this.timer = window.setTimeout(() => void this.refresh(false), REFRESH_MS);
  }

  private async refresh(initial: boolean) {
    if (!this.context || !this.stats.enabled || this.destroyed) return;
    this.controller?.abort();
    this.controller = new AbortController();
    this.stats.lastAttemptAt = new Date().toISOString();
    if (initial && !this.records.size) this.stats.state = 'loading';
    this.stats.error = null;
    this.publish();

    try {
      const items = await fetchEarthquakes(this.controller.signal);
      this.validate(items);
      if (this.destroyed || !this.stats.enabled) return;
      this.renderSnapshot(items.slice(0, BUDGETS.maxMaterializedRecords));
      this.stats.state = 'live';
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.provenance = {
        provider: 'USGS Earthquake Hazards Program',
        coverage: 'global',
        observedAt: this.stats.lastSuccessAt,
        cached: false,
      };
      this.stats.error = null;
    } catch (reason: unknown) {
      if (this.controller?.signal.aborted || this.destroyed) return;
      const message = reason instanceof Error ? reason.message : 'USGS refresh failed';
      this.stats.state = this.records.size ? 'degraded' : 'unavailable';
      this.stats.error = this.records.size ? `${message} · keeping last valid snapshot` : message;
    } finally {
      this.publish();
      this.schedule();
    }
  }

  async enable() {
    this.stats.enabled = true;
    if (this.collection) this.collection.show = this.sceneActive;
    this.publish();
    await this.refresh(!this.records.size);
  }

  disable() {
    this.stats.enabled = false;
    this.stats.state = 'idle';
    this.controller?.abort();
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.collection) this.collection.show = false;
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.records.size); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.collection) this.collection.show = active && this.stats.enabled;
    this.context?.requestRender();
  }

  onCameraChanged(_view: CameraView) {}
  getStats() { return { ...this.stats, provenance: this.stats.provenance ? { ...this.stats.provenance } : null }; }
  getEntity(id: string) { return this.records.get(id) ?? null; }
  select(_id: string | null) {}

  destroy() {
    this.destroyed = true;
    this.disable();
    this.records.clear();
    if (this.context && this.collection) this.context.viewer.scene.primitives.remove(this.collection);
    this.collection = null;
    this.context = null;
  }
}
