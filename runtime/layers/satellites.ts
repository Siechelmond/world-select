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
const TRACKED_PROPAGATION_MS = 200;
const GLYPH_BUDGET_CORE = 180;
const GLYPH_BUDGET_DENSE = 100;
const ORBIT_SAMPLES = 180;
const BUDGETS = {
  maxMaterializedRecords: 6000,
  maxVisibleGlyphs: 2200,
  maxLabels: 12,
  max3DModels: 0,
  maxTrails: 0,
  maxExpensiveGeometry: 2,
};

type CompiledSatellite = { record: TleRecord; satrec: any; norad: string };
type OrbitPath = { primitive: any; gmstAtBake: number };

const SATELLITE_ICON = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="white" stroke="#082f49" stroke-width="2" stroke-linejoin="round"><rect x="24" y="22" width="16" height="20" rx="3"/><rect x="4" y="24" width="16" height="16"/><rect x="44" y="24" width="16" height="16"/><path d="M20 32h4M40 32h4M32 22V12M27 12h10M32 42v10"/></g></svg>`)}`;

export class SatelliteLayer implements RuntimeLayer {
  readonly id = 'satellites' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private collection: any = null;
  private glyphs: any = null;
  private labels: any = null;
  private compiled: CompiledSatellite[] = [];
  private compiledById = new Map<string, CompiledSatellite>();
  private entities = new Map<string, SpatialEntity>();
  private points = new Map<string, any>();
  private glyphById = new Map<string, any>();
  private orbitPaths = new Map<string, OrbitPath>();
  private issId: string | null = null;
  private refreshTimer: number | null = null;
  private propagationTimer: number | null = null;
  private trackedTimer: number | null = null;
  private controller: AbortController | null = null;
  private catalog: SatelliteCatalog = 'core';
  private sceneActive = true;
  private selectedId: string | null = null;
  private cameraHeight = 9_500_000;
  private fixedTime: Date | null = null;
  private destroyed = false;

  init(context: LayerContext) {
    this.context = context;
    this.collection = context.viewer.scene.primitives.add(new context.Cesium.PointPrimitiveCollection());
    this.glyphs = context.viewer.scene.primitives.add(new context.Cesium.BillboardCollection());
    this.labels = context.viewer.scene.primitives.add(new context.Cesium.LabelCollection());
    this.collection.show = false;
    this.glyphs.show = false;
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
    this.compiledById = new Map(next.map((item) => [`celestrak:${item.norad}`, item]));
    this.issId = next.find((item) => /(^|\s)ISS(\s|$)|ZARYA/i.test(item.record.name)) ? `celestrak:${next.find((item) => /(^|\s)ISS(\s|$)|ZARYA/i.test(item.record.name))!.norad}` : null;
    this.rebuildPrimitives();
    this.rebuildOrbitPaths();
  }

  private visibleBudget() {
    if (this.cameraHeight > 8_000_000) return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 1600 : 900);
    if (this.cameraHeight > 2_000_000) return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 2000 : 1200);
    return Math.min(BUDGETS.maxVisibleGlyphs, this.catalog === 'dense' ? 2200 : 1500);
  }

  private glyphBudget() {
    return this.catalog === 'dense' ? GLYPH_BUDGET_DENSE : GLYPH_BUDGET_CORE;
  }

  private addGlyph(id: string) {
    if (!this.context || !this.glyphs || this.glyphById.has(id)) return;
    const selected = id === this.selectedId;
    const isIss = id === this.issId;
    const size = selected ? 26 : isIss ? 23 : 16;
    const glyph = this.glyphs.add({
      id,
      image: SATELLITE_ICON,
      position: this.context.Cesium.Cartesian3.ZERO,
      width: size,
      height: size,
      color: selected
        ? this.context.Cesium.Color.fromCssColorString('#fef08a')
        : isIss
          ? this.context.Cesium.Color.WHITE
          : this.context.Cesium.Color.fromCssColorString('#a5f3fc'),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new this.context.Cesium.NearFarScalar(500_000, 1.2, 30_000_000, 0.55),
    });
    this.glyphById.set(id, glyph);
    const point = this.points.get(id);
    if (point) point.show = false;
  }

  private ensureHeroGlyphs(visible: CompiledSatellite[]) {
    const budget = this.glyphBudget();
    const stride = Math.max(1, Math.floor(visible.length / Math.max(1, budget)));
    for (let index = 0; index < visible.length && this.glyphById.size < budget; index += stride) {
      this.addGlyph(`celestrak:${visible[index].norad}`);
    }
    if (this.issId) this.addGlyph(this.issId);
    if (this.selectedId) this.addGlyph(this.selectedId);
  }

  private rebuildPrimitives() {
    if (!this.context || !this.collection || !this.glyphs || !this.labels) return;
    this.collection.removeAll();
    this.glyphs.removeAll();
    this.labels.removeAll();
    this.points.clear();
    this.glyphById.clear();
    const visible = this.compiled.slice(0, this.visibleBudget());
    for (const item of visible) {
      const id = `celestrak:${item.norad}`;
      const point = this.collection.add({
        id,
        position: this.context.Cesium.Cartesian3.ZERO,
        pixelSize: this.cameraHeight > 5_000_000 ? 4 : 6,
        color: this.context.Cesium.Color.fromCssColorString('#67e8f9'),
        outlineColor: this.context.Cesium.Color.WHITE,
        outlineWidth: 0.5,
      });
      this.points.set(id, point);
    }
    this.ensureHeroGlyphs(visible);
    this.stats.visibleCount = visible.length;
    this.collection.show = this.stats.enabled && this.sceneActive;
    this.glyphs.show = this.stats.enabled && this.sceneActive;
    this.labels.show = this.stats.enabled && this.sceneActive;
    this.propagate();
  }

  private toSpatialEntity(item: CompiledSatellite, at: Date, longitude: number, latitude: number, altitudeMeters: number): SpatialEntity {
    return {
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
        visual: item.norad === this.issId?.replace('celestrak:', '') ? 'ISS hero glyph + live orbit' : 'satellite glyph/point LOD',
      },
    };
  }

  private positionFor(item: CompiledSatellite, at: Date) {
    let propagated: any;
    try { propagated = satellite.propagate(item.satrec, at); } catch { return null; }
    if (!propagated?.position || typeof propagated.position === 'boolean') return null;
    const gmst = satellite.gstime(at);
    const gd = satellite.eciToGeodetic(propagated.position, gmst);
    const longitude = satellite.degreesLong(gd.longitude);
    const latitude = satellite.degreesLat(gd.latitude);
    const altitudeMeters = gd.height * 1000;
    if (![longitude, latitude, altitudeMeters].every(Number.isFinite)) return null;
    return { longitude, latitude, altitudeMeters };
  }

  private applyPosition(item: CompiledSatellite, at: Date, updateEntity = true) {
    if (!this.context) return null;
    const pos = this.positionFor(item, at);
    if (!pos) return null;
    const id = `celestrak:${item.norad}`;
    const entity = this.toSpatialEntity(item, at, pos.longitude, pos.latitude, pos.altitudeMeters);
    if (updateEntity) this.entities.set(id, entity);
    const cartesian = this.context.Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitudeMeters);
    const point = this.points.get(id);
    if (point) {
      point.position = cartesian;
      point.id = entity;
      point.pixelSize = id === this.selectedId ? 9 : this.cameraHeight > 5_000_000 ? 4 : 6;
      point.outlineWidth = id === this.selectedId ? 2 : 0.5;
    }
    const glyph = this.glyphById.get(id);
    if (glyph) {
      const selected = id === this.selectedId;
      const isIss = id === this.issId;
      glyph.position = cartesian;
      glyph.id = entity;
      glyph.width = selected ? 26 : isIss ? 23 : 16;
      glyph.height = selected ? 26 : isIss ? 23 : 16;
      glyph.color = selected
        ? this.context.Cesium.Color.fromCssColorString('#fef08a')
        : isIss
          ? this.context.Cesium.Color.WHITE
          : this.context.Cesium.Color.fromCssColorString('#a5f3fc');
    }
    return entity;
  }

  private propagate() {
    if (!this.context || !this.stats.enabled || !this.sceneActive || !this.context.isSceneActive() || !this.compiled.length || this.destroyed) return;
    const at = this.fixedTime ?? new Date();
    const visibleLimit = this.visibleBudget();
    this.entities.clear();
    let rendered = 0;
    let issEntity: SpatialEntity | null = null;

    for (const item of this.compiled.slice(0, visibleLimit)) {
      const entity = this.applyPosition(item, at, true);
      if (!entity) continue;
      if (entity.id === this.issId) issEntity = entity;
      rendered += 1;
    }

    this.stats.count = this.compiled.length;
    this.stats.visibleCount = rendered;
    this.updateLabels(issEntity);
    this.updateOrbitRotations(at);
    this.context.requestRender();
  }

  private updateTrackedOnly() {
    if (!this.context || !this.selectedId || !this.stats.enabled || !this.sceneActive || this.fixedTime || this.destroyed) return;
    const item = this.compiledById.get(this.selectedId);
    if (!item) return;
    const at = new Date();
    const entity = this.applyPosition(item, at, true);
    if (entity) this.updateLabels(this.issId ? this.entities.get(this.issId) ?? null : null);
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
        text: entity.id === this.issId ? `ISS · ${entity.name}` : entity.name,
        font: '11px sans-serif',
        fillColor: Cesium.Color.WHITE,
        pixelOffset: new Cesium.Cartesian2(12, -12),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.68),
      });
    }
  }

  private orbitalPeriodMinutes(item: CompiledSatellite) {
    const meanMotion = Number(item.record.line2.slice(52, 63).trim());
    if (!Number.isFinite(meanMotion) || meanMotion <= 0) return 96;
    return Math.max(60, Math.min(1_600, 1440 / meanMotion));
  }

  private buildOrbitPath(item: CompiledSatellite, color: any) {
    if (!this.context || this.orbitPaths.has(`celestrak:${item.norad}`)) return;
    const { Cesium, viewer } = this.context;
    const bakeDate = this.fixedTime ?? new Date();
    const gmstAtBake = satellite.gstime(bakeDate);
    const periodMs = this.orbitalPeriodMinutes(item) * 60_000;
    const positions: any[] = [];
    for (let index = 0; index <= ORBIT_SAMPLES; index += 1) {
      const t = new Date(bakeDate.getTime() + (index / ORBIT_SAMPLES - 0.5) * periodMs);
      let propagated: any;
      try { propagated = satellite.propagate(item.satrec, t); } catch { continue; }
      if (!propagated?.position || typeof propagated.position === 'boolean') continue;
      // Freeze the entire inertial orbit into the ECEF frame at bake time. The
      // primitive is then rigidly rotated by the GMST delta instead of rebuilding
      // geometry every second, matching GEV's no-flicker ring strategy.
      const ecf = satellite.eciToEcf(propagated.position, gmstAtBake);
      if (![ecf.x, ecf.y, ecf.z].every(Number.isFinite)) continue;
      positions.push(new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000));
    }
    if (positions.length < 2) return;
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions,
          width: `celestrak:${item.norad}` === this.issId ? 2.6 : 2.0,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.62)),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.28)),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
      allowPicking: false,
    });
    viewer.scene.primitives.add(primitive);
    this.orbitPaths.set(`celestrak:${item.norad}`, { primitive, gmstAtBake });
  }

  private removeOrbitPath(id: string) {
    const path = this.orbitPaths.get(id);
    if (!path || !this.context) return;
    try { this.context.viewer.scene.primitives.remove(path.primitive); } catch { /* already removed */ }
    this.orbitPaths.delete(id);
  }

  private rebuildOrbitPaths() {
    for (const id of Array.from(this.orbitPaths.keys())) this.removeOrbitPath(id);
    if (!this.context) return;
    if (this.issId) {
      const iss = this.compiledById.get(this.issId);
      if (iss) this.buildOrbitPath(iss, this.context.Cesium.Color.fromCssColorString('#67e8f9'));
    }
    if (this.selectedId && this.selectedId !== this.issId) {
      const selected = this.compiledById.get(this.selectedId);
      if (selected) this.buildOrbitPath(selected, this.context.Cesium.Color.fromCssColorString('#fef08a'));
    }
  }

  private updateOrbitRotations(at: Date) {
    if (!this.context || !this.orbitPaths.size) return;
    const { Cesium } = this.context;
    const gmstNow = satellite.gstime(at);
    for (const path of this.orbitPaths.values()) {
      const delta = -(gmstNow - path.gmstAtBake);
      const rotation = Cesium.Matrix3.fromRotationZ(delta);
      path.primitive.modelMatrix = Cesium.Matrix4.fromRotationTranslation(rotation, Cesium.Cartesian3.ZERO);
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (!this.stats.enabled || this.destroyed) return;
    this.refreshTimer = window.setTimeout(() => void this.refresh(false), REFRESH_MS);
  }

  private startPropagation() {
    if (this.propagationTimer != null) window.clearInterval(this.propagationTimer);
    if (this.trackedTimer != null) window.clearInterval(this.trackedTimer);
    this.propagationTimer = window.setInterval(() => this.propagate(), PROPAGATION_MS);
    this.trackedTimer = window.setInterval(() => this.updateTrackedOnly(), TRACKED_PROPAGATION_MS);
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
    this.glyphs.show = this.sceneActive;
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
    if (this.trackedTimer != null) window.clearInterval(this.trackedTimer);
    this.refreshTimer = null;
    this.propagationTimer = null;
    this.trackedTimer = null;
    if (this.collection) this.collection.show = false;
    if (this.glyphs) this.glyphs.show = false;
    if (this.labels) this.labels.show = false;
    this.select(null);
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.compiled.length); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.collection) this.collection.show = active && this.stats.enabled;
    if (this.glyphs) this.glyphs.show = active && this.stats.enabled;
    if (this.labels) this.labels.show = active && this.stats.enabled;
    for (const path of this.orbitPaths.values()) path.primitive.show = active && this.stats.enabled;
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
    if (id) this.addGlyph(id);
    this.rebuildOrbitPaths();
    if (this.stats.enabled) this.propagate();
  }

  destroy() {
    this.destroyed = true;
    this.disable();
    for (const id of Array.from(this.orbitPaths.keys())) this.removeOrbitPath(id);
    if (this.context && this.collection) this.context.viewer.scene.primitives.remove(this.collection);
    if (this.context && this.glyphs) this.context.viewer.scene.primitives.remove(this.glyphs);
    if (this.context && this.labels) this.context.viewer.scene.primitives.remove(this.labels);
    this.collection = null;
    this.glyphs = null;
    this.labels = null;
    this.compiled = [];
    this.compiledById.clear();
    this.entities.clear();
    this.points.clear();
    this.glyphById.clear();
    this.context = null;
  }
}
