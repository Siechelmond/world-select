import * as satellite from 'satellite.js';
import { fetchStationTles, type SatelliteCatalog, type TleRecord } from '@/lib/celestrak';
import type { SpatialEntity } from '@/lib/spatial';
import {
  createInitialLayerStats,
  type CameraView,
  type LayerContext,
  type RuntimeLayer,
  type RuntimeLayerStats,
} from '@/runtime/types';

const REFRESH_MS = 120_000;
const PROPAGATION_MS = 1_000;
const BUDGETS = {
  maxMaterializedRecords: 6000,
  maxVisibleGlyphs: 2200,
  maxLabels: 12,
  max3DModels: 0,
  maxTrails: 1,
  maxExpensiveGeometry: 1,
};

type CompiledSatellite = { record: TleRecord; satrec: any; norad: string };

export class SatelliteLayer implements RuntimeLayer {
  readonly id = 'satellites' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private collection: any = null;
  private labels: any = null;
  private compiled: CompiledSatellite[] = [];
  private entities = new Map<string, SpatialEntity>();
  private points = new Map<string, any>();
  private refreshTimer: number | null = null;
  private propagationTimer: number | null = null;
  private controller: AbortController | null = null;
  private catalog: SatelliteCatalog = 'core';
  private sceneActive = true;
  private selectedId: string | null = null;
  private selectedTrailEntity: any = null;
  private selectedTrail: any[] = [];
  private cameraHeight = 9_500_000;
  private fixedTime: Date | null = null;
  private destroyed = false;

  init(context: LayerContext) {
    this.context = context;
    this.collection = context.viewer.scene.primitives.add(new context.Cesium.PointPrimitiveCollection());
    this.labels = context.viewer.scene.primitives.add(new context.Cesium.LabelCollection());
    this.collection.show = false;
    this.labels.show = false;
  }

  private publish() { this.context?.onStatsChanged(); }

  setCatalog(catalog: SatelliteCatalog) {
    if (this.catalog === catalog) return;
    this.catalog = catalog;
    if (this.stats.enabled) void this.refresh(true);
  }

  getCatalog() { return this.catalog; }

  setTime(at: Date | null) {
    this.fixedTime = at;
    if (this.stats.enabled) this.propagate();
  }

  private compile(records: TleRecord[]) {
    const seen = new Set<string>();
    const next: CompiledSatellite[] = [];
    for (const record of records.slice(0, BUDGETS.maxMaterializedRecords)) {
      const norad = record.line1.slice(2, 7).trim();
      if (!norad || seen.has(norad) || !record.line1.startsWith('1 ') || !record.line2.startsWith('2 ')) continue;
      try {
        const satrec = satellite.twoline2satrec(record.line1, record.line2);
        if (!satrec) continue;
        seen.add(norad);
        next.push({ record, satrec, norad });
      } catch {
        // Reject only malformed rows; a catalog stays usable if other rows are valid.
      }
    }
    if (!next.length) throw new Error('CelesTrak returned no usable TLE records');
    this.compiled = next;
    this.rebuildPrimitives();
  }

  private visibleBudget() {
    if (this.cameraHeight > 8_000_000) return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 1600 : 900);
    if (this.cameraHeight > 2_000_000) return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 2000 : 1200);
    return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 2200 : 1500);
  }

  private rebuildPrimitives() {
    if (!this.context || !this.collection || !this.labels) return;
    this.collection.removeAll();
    this.labels.removeAll();
    this.points.clear();
    const visible = this.compiled.slice(0, this.visibleBudget());
    for (const item of visible) {
      const point = this.collection.add({
        id: `satellite:${item.norad}`,
        position: this.context.Cesium.Cartesian3.ZERO,
        pixelSize: this.cameraHeight > 5_000_000 ? 4 : 6,
        color: this.context.Cesium.Color.fromCssColorString('#67e8f9'),
        outlineColor: this.context.Cesium.Color.WHITE,
        outlineWidth: 0.5,
      });
      this.points.set(`celestrak:${item.norad}`, point);
    }
    this.stats.visibleCount = visible.length;
    this.collection.show = this.stats.enabled && this.sceneActive;
    this.labels.show = this.stats.enabled && this.sceneActive;
    this.propagate();
  }

  private propagate() {
    if (!this.context || !this.stats.enabled || !this.sceneActive || !this.context.isSceneActive() || !this.compiled.length || this.destroyed) return;
    const { Cesium } = this.context;
    const at = this.fixedTime ?? new Date();
    const gmst = satellite.gstime(at);
    const visibleLimit = this.visibleBudget();
    this.entities.clear();
    let rendered = 0;
    let selectedPosition: any = null;
    let issEntity: SpatialEntity | null = null;

    for (const item of this.compiled.slice(0, visibleLimit)) {
      let propagated: any;
      try { propagated = satellite.propagate(item.satrec, at); } catch { continue; }
      if (!propagated?.position || typeof propagated.position === 'boolean') continue;
      const gd = satellite.eciToGeodetic(propagated.position, gmst);
      const longitude = satellite.degreesLong(gd.longitude);
      const latitude = satellite.degreesLat(gd.latitude);
      const altitudeMeters = gd.height * 1000;
      if (![longitude, latitude, altitudeMeters].every(Number.isFinite)) continue;
      const entity: SpatialEntity = {
        id: `celestrak:${item.norad}`,
        kind: 'satellite',
        name: item.record.name,
        position: { longitude, latitude, altitudeMeters },
        observedAt: at.toISOString(),
        dataState: 'CALCULATED',
        source: { id: 'celestrak-gp', label: 'CelesTrak GP / NORAD', url: 'https://celestrak.org/NORAD/elements/' },
        properties: {
          noradCatalogNumber: item.norad,
          altitudeKm: Number((altitudeMeters / 1000).toFixed(1)),
          propagation: 'SGP4 from cached current GP/TLE',
          catalog: this.catalog,
        },
      };
      this.entities.set(entity.id, entity);
      const point = this.points.get(entity.id);
      if (point && rendered < visibleLimit) {
        const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitudeMeters);
        point.position = position;
        point.id = entity;
        point.pixelSize = entity.id === this.selectedId ? 9 : this.cameraHeight > 5_000_000 ? 4 : 6;
        point.outlineWidth = entity.id === this.selectedId ? 2 : 0.5;
        if (entity.id === this.selectedId) selectedPosition = position;
        if (!issEntity && /(^|\s)ISS(\s|$)|ZARYA/i.test(entity.name)) issEntity = entity;
        rendered += 1;
      }
    }

    this.stats.count = this.compiled.length;
    this.stats.visibleCount = rendered;
    this.updateLabels(issEntity);
    this.updateSelectedTrail(selectedPosition);
    this.context.requestRender();
  }

  private updateLabels(issEntity: SpatialEntity | null) {
    if (!this.context || !this.labels) return;
    const { Cesium } = this.context;
    this.labels.removeAll();
    const targets: SpatialEntity[] = [];
    const selected = this.selectedId ? this.entities.get(this.selectedId) : null;
    if (selected) targets.push(selected);
    if (issEntity && issEntity.id !== selected?.id) targets.push(issEntity);
    for (const entity of targets.slice(0, BUDGETS.maxLabels)) {
      this.labels.add({
        id: entity,
        position: Cesium.Cartesian3.fromDegrees(entity.position.longitude, entity.position.latitude, entity.position.altitudeMeters),
        text: entity.name,
        font: '11px sans-serif',
        fillColor: Cesium.Color.WHITE,
        pixelOffset: new Cesium.Cartesian2(10, -10),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.68),
      });
    }
  }

  private updateSelectedTrail(position: any) {
    if (!this.context) return;
    const { Cesium, viewer } = this.context;
    if (!this.selectedId || !position) {
      if (this.selectedTrailEntity) viewer.entities.remove(this.selectedTrailEntity);
      this.selectedTrailEntity = null;
      this.selectedTrail = [];
      return;
    }
    const last = this.selectedTrail[this.selectedTrail.length - 1];
    if (!last || Cesium.Cartesian3.distance(last, position) > 2_000) {
      this.selectedTrail.push(position);
      while (this.selectedTrail.length > 48) this.selectedTrail.shift();
    }
    if (!this.selectedTrailEntity) {
      this.selectedTrailEntity = viewer.entities.add({
        id: '__runtime:satellite-trail',
        polyline: {
          positions: this.selectedTrail,
          width: 1.5,
          material: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.55),
        },
      });
    } else {
      this.selectedTrailEntity.polyline.positions = new Cesium.ConstantProperty([...this.selectedTrail]);
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (!this.stats.enabled || this.destroyed) return;
    this.refreshTimer = window.setTimeout(() => void this.refresh(false), REFRESH_MS);
  }

  private startPropagation() {
    if (this.propagationTimer != null) window.clearInterval(this.propagationTimer);
    this.propagationTimer = window.setInterval(() => this.propagate(), PROPAGATION_MS);
  }

  private async refresh(initial: boolean) {
    if (!this.context || !this.stats.enabled || this.destroyed) return;
    this.controller?.abort();
    this.controller = new AbortController();
    this.stats.lastAttemptAt = new Date().toISOString();
    if (initial && !this.compiled.length) this.stats.state = 'loading';
    this.stats.error = null;
    this.publish();
    try {
      const records = await fetchStationTles(this.controller.signal, this.catalog);
      if (this.destroyed || !this.stats.enabled) return;
      this.compile(records);
      this.stats.state = 'live';
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.provenance = {
        provider: `CelesTrak ${this.catalog.toUpperCase()}`,
        coverage: 'global',
        observedAt: this.stats.lastSuccessAt,
        cached: true,
      };
      this.stats.error = null;
    } catch (reason: unknown) {
      if (this.controller?.signal.aborted || this.destroyed) return;
      const message = reason instanceof Error ? reason.message : 'Satellite refresh failed';
      this.stats.state = this.compiled.length ? 'degraded' : 'unavailable';
      this.stats.error = this.compiled.length ? `${message} · keeping last valid TLE catalog` : message;
    } finally {
      this.publish();
      this.scheduleRefresh();
    }
  }

  async enable() {
    this.stats.enabled = true;
    this.collection.show = this.sceneActive;
    this.labels.show = this.sceneActive;
    this.startPropagation();
    this.publish();
    await this.refresh(!this.compiled.length);
  }

  disable() {
    this.stats.enabled = false;
    this.stats.state = 'idle';
    this.controller?.abort();
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (this.propagationTimer != null) window.clearInterval(this.propagationTimer);
    this.refreshTimer = null;
    this.propagationTimer = null;
    if (this.collection) this.collection.show = false;
    if (this.labels) this.labels.show = false;
    this.select(null);
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.compiled.length); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.collection) this.collection.show = active && this.stats.enabled;
    if (this.labels) this.labels.show = active && this.stats.enabled;
    if (active && this.stats.enabled) this.propagate();
    this.context?.requestRender();
  }

  onCameraChanged(view: CameraView) {
    const previousBudget = this.visibleBudget();
    this.cameraHeight = view.height;
    const nextBudget = this.visibleBudget();
    if (previousBudget !== nextBudget && this.stats.enabled) this.rebuildPrimitives();
  }

  getStats() { return { ...this.stats, provenance: this.stats.provenance ? { ...this.stats.provenance } : null }; }
  getEntity(id: string) { return this.entities.get(id) ?? null; }

  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.selectedTrail = [];
    if (this.selectedTrailEntity && this.context) this.context.viewer.entities.remove(this.selectedTrailEntity);
    this.selectedTrailEntity = null;
    if (this.stats.enabled) this.propagate();
  }

  destroy() {
    this.destroyed = true;
    this.disable();
    if (this.context && this.collection) this.context.viewer.scene.primitives.remove(this.collection);
    if (this.context && this.labels) this.context.viewer.scene.primitives.remove(this.labels);
    this.collection = null;
    this.labels = null;
    this.compiled = [];
    this.entities.clear();
    this.points.clear();
    this.context = null;
  }
}
