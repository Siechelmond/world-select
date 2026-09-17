import {
  fetchAircraftSnapshot,
  projectAircraftPosition,
  type AircraftFeedMeta,
} from '@/lib/aircraft';
import type { SpatialEntity } from '@/lib/spatial';
import { selectNearestCohort } from '@/runtime/core/cohort';
import {
  createInitialLayerStats,
  type CameraView,
  type LayerContext,
  type RuntimeLayer,
  type RuntimeLayerStats,
} from '@/runtime/types';

const REFRESH_MS = 30_000;
const INTERPOLATION_MS = 250;
const AIRCRAFT_ICON = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="white" stroke="#111827" stroke-width="2" d="M32 3c3 0 5 4 5 9v12l20 12v6L37 36v13l8 7v5l-13-4-13 4v-5l8-7V36L7 42v-6l20-12V12c0-5 2-9 5-9Z"/></svg>`)}`;

const BUDGETS = {
  maxMaterializedRecords: 20_000,
  maxVisibleGlyphs: 1800,
  maxLabels: 1,
  max3DModels: 12,
  maxTrails: 1,
  maxExpensiveGeometry: 1,
};

type Query = { latitude: number; longitude: number; radiusNm: number };

function queryForView(view: CameraView): Query {
  const step = view.height < 300_000 ? 0.05 : view.height < 2_000_000 ? 0.15 : 0.35;
  const radiusNm = view.height < 120_000 ? 70 : view.height < 1_000_000 ? 130 : 220;
  return {
    latitude: Math.round(view.latitude / step) * step,
    longitude: Math.round(view.longitude / step) * step,
    radiusNm,
  };
}

function sameQuery(a: Query, b: Query) {
  return a.latitude === b.latitude && a.longitude === b.longitude && a.radiusNm === b.radiusNm;
}


export class AircraftLayer implements RuntimeLayer {
  readonly id = 'aircraft' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private collection: any = null;
  private labels: any = null;
  private selectedLabel: any = null;
  private selectedLabelId: string | null = null;
  private records = new Map<string, SpatialEntity>();
  private billboards = new Map<string, any>();
  private visibleIds: string[] = [];
  private query: Query = { latitude: 48.2082, longitude: 16.3738, radiusNm: 220 };
  private cameraHeight = 9_500_000;
  private refreshTimer: number | null = null;
  private interpolationTimer: number | null = null;
  private cameraRefreshTimer: number | null = null;
  private controller: AbortController | null = null;
  private sceneActive = true;
  private selectedId: string | null = null;
  private followedId: string | null = null;
  private trackerEntity: any = null;
  private trailEntity: any = null;
  private observedTrail: Array<{ longitude: number; latitude: number; altitudeMeters: number }> = [];
  private lastMeta: AircraftFeedMeta | null = null;
  private destroyed = false;

  init(context: LayerContext) {
    this.context = context;
    this.collection = context.viewer.scene.primitives.add(new context.Cesium.BillboardCollection());
    this.labels = context.viewer.scene.primitives.add(new context.Cesium.LabelCollection());
    this.collection.show = false;
    this.labels.show = false;
  }

  private publish() { this.context?.onStatsChanged(); }

  getMeta() { return this.lastMeta; }
  getQuery() { return { ...this.query }; }

  private visibleBudget() {
    if (this.cameraHeight > 5_000_000) return 700;
    if (this.cameraHeight > 1_500_000) return 1100;
    return BUDGETS.maxVisibleGlyphs;
  }

  private rebuildVisibleCohort() {
    if (!this.context || !this.collection) return;
    const { Cesium } = this.context;
    this.collection.removeAll();
    this.billboards.clear();

    const budget = this.visibleBudget();
    const cohort = selectNearestCohort(this.records.values(), this.query, budget, this.selectedId);
    this.visibleIds = cohort.map((item) => item.id);

    for (const entity of cohort) {
      const speed = Number(entity.properties.groundSpeedKt ?? 0);
      const selected = entity.id === this.selectedId;
      const iconSize = this.cameraHeight > 2_000_000 ? 14 : speed > 250 ? 24 : 21;
      const billboard = this.collection.add({
        id: entity,
        image: AIRCRAFT_ICON,
        position: Cesium.Cartesian3.fromDegrees(entity.position.longitude, entity.position.latitude, entity.position.altitudeMeters),
        width: selected ? iconSize * 1.25 : iconSize,
        height: selected ? iconSize * 1.25 : iconSize,
        rotation: Cesium.Math.toRadians(-Number(entity.properties.trackDeg ?? 0)),
        color: selected ? Cesium.Color.fromCssColorString('#fde047') : Cesium.Color.fromCssColorString('#facc15'),
        disableDepthTestDistance: 3_000_000,
      });
      this.billboards.set(entity.id, billboard);
    }

    this.stats.count = this.records.size;
    this.stats.visibleCount = cohort.length;
    this.collection.show = this.stats.enabled && this.sceneActive;
    this.labels.show = this.stats.enabled && this.sceneActive;
    this.updateSelectionVisuals();
    this.tick();
    this.publish();
  }

  private updateSelectionVisuals(updateBillboards = true) {
    if (!this.context || !this.labels) return;
    const { Cesium } = this.context;
    const entity = this.selectedId ? this.records.get(this.selectedId) : null;
    if (!entity) {
      if (this.selectedLabel) this.labels.remove(this.selectedLabel);
      this.selectedLabel = null;
      this.selectedLabelId = null;
    } else {
      const projected = projectAircraftPosition(entity, Date.now());
      const position = Cesium.Cartesian3.fromDegrees(projected.longitude, projected.latitude, projected.altitudeMeters);
      if (!this.selectedLabel || this.selectedLabelId !== entity.id) {
        if (this.selectedLabel) this.labels.remove(this.selectedLabel);
        this.selectedLabel = this.labels.add({
          id: entity,
          position,
          text: entity.name,
          font: '11px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#fef08a'),
          pixelOffset: new Cesium.Cartesian2(13, -13),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.72),
        });
        this.selectedLabelId = entity.id;
      } else {
        this.selectedLabel.id = entity;
        this.selectedLabel.position = position;
        this.selectedLabel.text = entity.name;
      }
    }
    if (!updateBillboards) return;
    for (const [id, billboard] of this.billboards) {
      const selected = id === this.selectedId;
      billboard.color = selected ? Cesium.Color.fromCssColorString('#fde047') : Cesium.Color.fromCssColorString('#facc15');
    }
  }

  private appendObservedTrail(entity: SpatialEntity) {
    if (entity.id !== this.selectedId) return;
    const last = this.observedTrail[this.observedTrail.length - 1];
    if (!last || Math.abs(last.latitude - entity.position.latitude) > 0.0001 || Math.abs(last.longitude - entity.position.longitude) > 0.0001) {
      this.observedTrail.push({ ...entity.position });
      while (this.observedTrail.length > 36) this.observedTrail.shift();
    }
  }

  private updateTrailAndTracker(projected: { longitude: number; latitude: number; altitudeMeters: number }) {
    if (!this.context) return;
    const { Cesium, viewer } = this.context;
    if (this.selectedId && this.observedTrail.length > 1) {
      const positions = this.observedTrail.map((item) => Cesium.Cartesian3.fromDegrees(item.longitude, item.latitude, item.altitudeMeters));
      if (!this.trailEntity) {
        this.trailEntity = viewer.entities.add({
          id: '__runtime:aircraft-trail',
          polyline: {
            positions,
            width: 2,
            material: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.65),
            clampToGround: false,
          },
        });
      } else {
        this.trailEntity.polyline.positions = new Cesium.ConstantProperty(positions);
      }
    }

    if (this.followedId && this.followedId === this.selectedId) {
      const position = Cesium.Cartesian3.fromDegrees(projected.longitude, projected.latitude, projected.altitudeMeters);
      if (!this.trackerEntity) {
        this.trackerEntity = viewer.entities.add({ id: '__runtime:aircraft-follow', position, point: { show: false } });
      } else {
        this.trackerEntity.position = new Cesium.ConstantPositionProperty(position);
      }
      if (viewer.trackedEntity !== this.trackerEntity) viewer.trackedEntity = this.trackerEntity;
    }
  }

  private clearFollow() {
    if (!this.context) return;
    const viewer = this.context.viewer;
    if (viewer.trackedEntity === this.trackerEntity) viewer.trackedEntity = undefined;
    if (this.trackerEntity) viewer.entities.remove(this.trackerEntity);
    this.trackerEntity = null;
    this.followedId = null;
  }

  setFollowing(id: string | null) {
    if (!id) {
      this.clearFollow();
      this.publish();
      return;
    }
    if (!this.records.has(id)) return;
    this.followedId = id;
    this.selectedId = id;
    this.publish();
    this.tick();
  }

  private tick() {
    if (!this.context || !this.stats.enabled || !this.sceneActive || !this.context.isSceneActive() || this.destroyed) return;
    const { Cesium } = this.context;
    const atMs = Date.now();
    for (const id of this.visibleIds) {
      const entity = this.records.get(id);
      const billboard = this.billboards.get(id);
      if (!entity || !billboard) continue;
      const projected = this.cameraHeight < 900_000 ? projectAircraftPosition(entity, atMs) : entity.position;
      billboard.position = Cesium.Cartesian3.fromDegrees(projected.longitude, projected.latitude, projected.altitudeMeters);
      billboard.rotation = Cesium.Math.toRadians(-Number(entity.properties.trackDeg ?? 0));
      billboard.id = entity;
      if (id === this.selectedId) this.updateTrailAndTracker(projected);
    }
    this.updateSelectionVisuals(false);
    this.context.requestRender();
  }

  private startInterpolation() {
    if (this.interpolationTimer != null) window.clearInterval(this.interpolationTimer);
    this.interpolationTimer = window.setInterval(() => {
      if (this.cameraHeight < 900_000 || this.followedId) this.tick();
    }, INTERPOLATION_MS);
  }

  private scheduleRefresh(delay = REFRESH_MS) {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (!this.stats.enabled || this.destroyed) return;
    this.refreshTimer = window.setTimeout(() => void this.refresh(false), delay);
  }

  private applySnapshot(items: SpatialEntity[], meta: AircraftFeedMeta) {
    const next = new Map<string, SpatialEntity>();
    for (const item of items.slice(0, BUDGETS.maxMaterializedRecords)) {
      next.set(item.id, {
        ...item,
        properties: {
          ...item.properties,
          lodContract: '2D glyph far; selected/near cohort eligible for bounded 3D handoff',
        },
      });
    }
    this.records = next;
    this.lastMeta = meta;
    if (this.selectedId) {
      const selected = this.records.get(this.selectedId);
      if (selected) this.appendObservedTrail(selected);
      else this.select(null);
    }
    this.rebuildVisibleCohort();
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
      const snapshot = await fetchAircraftSnapshot({
        latitude: this.query.latitude,
        longitude: this.query.longitude,
        radiusNm: this.query.radiusNm,
      }, this.controller.signal);
      if (this.destroyed || !this.stats.enabled) return;

      if (!snapshot.entities.length) {
        if (!this.records.size) throw new Error(`No positioned aircraft returned within ${this.query.radiusNm} NM`);
        this.stats.state = 'degraded';
        this.stats.error = 'Refresh returned no positioned aircraft · keeping last valid snapshot';
        this.scheduleRefresh(REFRESH_MS);
        this.publish();
        return;
      }

      this.applySnapshot(snapshot.entities, snapshot.meta);
      const degraded = snapshot.meta.degraded || snapshot.meta.stale;
      this.stats.state = degraded ? 'degraded' : 'live';
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.provenance = {
        provider: snapshot.meta.provider,
        coverage: snapshot.meta.coverage,
        observedAt: this.stats.lastSuccessAt,
        sourceAgeSeconds: snapshot.meta.sourceAgeSeconds,
        cached: snapshot.meta.cached,
        authMode: snapshot.meta.authMode,
      };
      this.stats.error = degraded
        ? `Using ${snapshot.meta.cached ? 'cached ' : ''}${snapshot.meta.provider} data${snapshot.meta.sourceAgeSeconds != null ? ` · ${snapshot.meta.sourceAgeSeconds}s old` : ''}`
        : null;
    } catch (reason: unknown) {
      if (this.controller?.signal.aborted || this.destroyed) return;
      const message = reason instanceof Error ? reason.message : 'Aircraft refresh failed';
      this.stats.state = this.records.size ? 'degraded' : 'unavailable';
      this.stats.error = this.records.size ? `${message} · keeping last valid aircraft snapshot` : message;
      if (!this.records.size) this.lastMeta = null;
    } finally {
      this.publish();
      this.scheduleRefresh(this.records.size ? REFRESH_MS : 60_000);
    }
  }

  async enable() {
    this.stats.enabled = true;
    if (this.collection) this.collection.show = this.sceneActive;
    if (this.labels) this.labels.show = this.sceneActive;
    this.startInterpolation();
    this.publish();
    await this.refresh(!this.records.size);
  }

  disable() {
    this.stats.enabled = false;
    this.stats.state = 'idle';
    this.controller?.abort();
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (this.interpolationTimer != null) window.clearInterval(this.interpolationTimer);
    if (this.cameraRefreshTimer != null) window.clearTimeout(this.cameraRefreshTimer);
    this.refreshTimer = null;
    this.interpolationTimer = null;
    this.cameraRefreshTimer = null;
    if (this.collection) this.collection.show = false;
    if (this.labels) this.labels.show = false;
    this.select(null);
    this.clearFollow();
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.records.size); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.collection) this.collection.show = active && this.stats.enabled;
    if (this.labels) this.labels.show = active && this.stats.enabled;
    if (active && this.stats.enabled) this.tick();
    this.context?.requestRender();
  }

  onCameraChanged(view: CameraView) {
    const previousBudget = this.visibleBudget();
    this.cameraHeight = view.height;
    const nextQuery = queryForView(view);
    const queryChanged = !sameQuery(this.query, nextQuery);
    this.query = nextQuery;
    if (previousBudget !== this.visibleBudget() && this.records.size) this.rebuildVisibleCohort();
    if (!view.moving && queryChanged && this.stats.enabled) {
      if (this.cameraRefreshTimer != null) window.clearTimeout(this.cameraRefreshTimer);
      this.cameraRefreshTimer = window.setTimeout(() => void this.refresh(false), 250);
    }
  }

  getStats() { return { ...this.stats, provenance: this.stats.provenance ? { ...this.stats.provenance } : null }; }
  getEntity(id: string) { return this.records.get(id) ?? null; }

  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.observedTrail = [];
    if (this.trailEntity && this.context) this.context.viewer.entities.remove(this.trailEntity);
    this.trailEntity = null;
    if (this.followedId && this.followedId !== id) this.clearFollow();
    const selected = id ? this.records.get(id) : null;
    if (selected) this.appendObservedTrail(selected);
    if (this.records.size) this.rebuildVisibleCohort();
    else this.updateSelectionVisuals();
  }

  destroy() {
    this.destroyed = true;
    this.disable();
    if (this.context && this.collection) this.context.viewer.scene.primitives.remove(this.collection);
    if (this.context && this.labels) this.context.viewer.scene.primitives.remove(this.labels);
    this.collection = null;
    this.labels = null;
    this.selectedLabel = null;
    this.selectedLabelId = null;
    this.records.clear();
    this.billboards.clear();
    this.context = null;
  }
}
