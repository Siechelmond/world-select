import {
  fetchAircraftSnapshot,
  fetchMilitarySnapshot,
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
  type AircraftSourceState,
  type AircraftSourceSummary,
} from '@/runtime/types';

const REFRESH_MS = 30_000;
const INTERPOLATION_MS = 500;
const CONNECT_GRACE_MS = 75_000;
const CONNECT_RETRY_MS = 20_000;

type AircraftDisplayMode = 'all' | 'civilian' | 'military';
type Query = { latitude: number; longitude: number; radiusNm: number; scope: 'global' | 'regional' };

function svgIcon(body: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="white" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round">${body}</g></svg>`)}`;
}

const AIRCRAFT_ICONS: Record<string, string> = {
  airliner: svgIcon('<path d="M32 3c3 0 5 4 5 9v12l20 12v6L37 36v13l8 7v5l-13-4-13 4v-5l8-7V36L7 42v-6l20-12V12c0-5 2-9 5-9Z"/>'),
  widebody: svgIcon('<path d="M32 2c4 0 6 4 6 10v11l22 11v8L38 37v12l10 7v5l-16-4-16 4v-5l10-7V37L4 42v-8l22-11V12c0-6 2-10 6-10Z"/>'),
  turboprop: svgIcon('<path d="M32 6c3 0 5 3 5 8v12l17 8v6l-17-4v12l8 6v4l-13-3-13 3v-4l8-6V36l-17 4v-6l17-8V14c0-5 2-8 5-8Z"/><circle cx="16" cy="33" r="4" fill="none"/><circle cx="48" cy="33" r="4" fill="none"/>'),
  helicopter: svgIcon('<path d="M22 25h23c7 0 11 4 11 9s-4 9-11 9H27l-7 8h-6l4-9H8c-3 0-5-2-5-5s2-5 5-5h10l4-7Z"/><path d="M29 24V12h5v12Z"/><path d="M11 10h41v4H11Z"/><path d="M54 26l8-7v14Z"/>'),
  fastjet: svgIcon('<path d="M32 3l6 19 19 12v6L38 35l5 20 8 4v3l-19-4-19 4v-3l8-4 5-20-19 5v-6l19-12 6-19Z"/>'),
  light: svgIcon('<path d="M32 7c3 0 4 4 4 8v12l17 8v5l-17-3v11l7 6v4l-11-3-11 3v-4l7-6V37l-17 3v-5l17-8V15c0-4 1-8 4-8Z"/>'),
};

const BUDGETS = {
  maxMaterializedRecords: 20_000,
  maxVisibleGlyphs: 4_500,
  maxLabels: 1,
  max3DModels: 12,
  maxTrails: 1,
  maxExpensiveGeometry: 1,
};

function queryForView(view: CameraView): Query {
  const step = view.height < 300_000 ? 0.05 : view.height < 2_000_000 ? 0.15 : 0.35;
  const radiusNm = view.height < 120_000 ? 70 : view.height < 1_000_000 ? 130 : 220;
  return {
    latitude: Math.round(view.latitude / step) * step,
    longitude: Math.round(view.longitude / step) * step,
    radiusNm,
    // On globe / continental views request the worldwide OpenSky frame. Close
    // to the ground, switch to a cheaper local envelope while preserving the
    // global military source as a separately filtered cohort.
    scope: view.height >= 2_500_000 ? 'global' : 'regional',
  };
}

function sameQuery(a: Query, b: Query) {
  return a.latitude === b.latitude && a.longitude === b.longitude && a.radiusNm === b.radiusNm && a.scope === b.scope;
}

function isMilitary(entity: SpatialEntity) {
  return Boolean(entity.properties.military);
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
  private civilianRecords = new Map<string, SpatialEntity>();
  private militaryRecords = new Map<string, SpatialEntity>();
  private civilianMeta: AircraftFeedMeta | null = null;
  private militaryMeta: AircraftFeedMeta | null = null;
  private civilianHealthState: AircraftSourceState = 'idle';
  private militaryHealthState: AircraftSourceState = 'idle';
  private civilianHealthError: string | null = null;
  private militaryHealthError: string | null = null;
  private connectStartedAt: number | null = null;
  private billboards = new Map<string, any>();
  private visibleIds: string[] = [];
  private query: Query = { latitude: 48.2082, longitude: 16.3738, radiusNm: 220, scope: 'global' };
  private cameraHeight = 9_500_000;
  private displayMode: AircraftDisplayMode = 'all';
  private refreshTimer: number | null = null;
  private interpolationTimer: number | null = null;
  private cameraRefreshTimer: number | null = null;
  private controller: AbortController | null = null;
  private sceneActive = true;
  private selectedId: string | null = null;
  private followedId: string | null = null;
  private trackerEntity: any = null;
  private trailEntity: any = null;
  private coverageEntity: any = null;
  private observedTrail: Array<{ longitude: number; latitude: number; altitudeMeters: number }> = [];
  private lastMeta: AircraftFeedMeta | null = null;
  private lastMilitaryCount = 0;
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
  getDisplayMode() { return this.displayMode; }
  getMilitaryCount() { return this.lastMilitaryCount; }
  getSourceSummary(): AircraftSourceSummary {
    return {
      allCount: this.records.size,
      civilian: {
        state: this.civilianHealthState,
        count: this.civilianRecords.size,
        provider: this.civilianMeta?.provider ?? null,
        coverage: this.civilianMeta?.coverage ?? null,
        error: this.civilianHealthError,
      },
      military: {
        state: this.militaryHealthState,
        count: this.militaryRecords.size,
        provider: this.militaryMeta?.provider ?? null,
        coverage: this.militaryMeta?.coverage ?? null,
        error: this.militaryHealthError,
      },
    };
  }

  setDisplayMode(mode: AircraftDisplayMode) {
    if (mode !== 'all' && mode !== 'civilian' && mode !== 'military') return;
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    if (this.selectedId) {
      const selected = this.records.get(this.selectedId);
      if (selected && !this.matchesDisplayMode(selected)) this.select(null);
    }
    if (this.records.size) this.rebuildVisibleCohort();
    this.publish();
  }

  private matchesDisplayMode(entity: SpatialEntity) {
    if (this.displayMode === 'all') return true;
    return this.displayMode === 'military' ? isMilitary(entity) : !isMilitary(entity);
  }

  private visibleBudget() {
    // Far-out globe views need fewer glyphs, not more. This keeps continental
    // traffic readable and prevents the dense white 'aircraft carpet' seen in UAT.
    if (this.cameraHeight > 8_000_000) return 850;
    if (this.cameraHeight > 5_000_000) return 1_250;
    if (this.cameraHeight > 2_000_000) return 2_100;
    if (this.cameraHeight > 750_000) return 2_600;
    return 1_800;
  }

  private filteredRecords() {
    return Array.from(this.records.values()).filter((entity) => this.matchesDisplayMode(entity));
  }

  private iconFor(entity: SpatialEntity) {
    const aircraftClass = String(entity.properties.aircraftClass ?? 'airliner');
    return AIRCRAFT_ICONS[aircraftClass] ?? AIRCRAFT_ICONS.airliner;
  }

  private colorFor(entity: SpatialEntity, selected = false) {
    if (!this.context) return undefined;
    const { Cesium } = this.context;
    if (selected) return Cesium.Color.fromCssColorString('#67e8f9');
    return isMilitary(entity)
      ? Cesium.Color.fromCssColorString('#facc15')
      : Cesium.Color.fromCssColorString('#f8fafc');
  }

  private rebuildVisibleCohort() {
    if (!this.context || !this.collection) return;
    const { Cesium } = this.context;
    this.collection.removeAll();
    this.billboards.clear();

    const budget = this.visibleBudget();
    const filtered = this.filteredRecords();
    const cohort = selectNearestCohort(filtered, this.query, budget, this.selectedId);
    this.visibleIds = cohort.map((item) => item.id);

    for (const entity of cohort) {
      const speed = Number(entity.properties.groundSpeedKt ?? 0);
      const selected = entity.id === this.selectedId;
      const aircraftClass = String(entity.properties.aircraftClass ?? 'airliner');
      const baseSize = aircraftClass === 'widebody' ? 24 : aircraftClass === 'helicopter' || aircraftClass === 'fastjet' ? 19 : 21;
      const farScale = this.cameraHeight > 8_000_000 ? 0.52 : this.cameraHeight > 5_000_000 ? 0.62 : this.cameraHeight > 2_000_000 ? 0.78 : 1;
      const iconSize = Math.max(10, (speed > 250 ? baseSize + 2 : baseSize) * farScale);
      const billboard = this.collection.add({
        id: entity,
        image: this.iconFor(entity),
        position: Cesium.Cartesian3.fromDegrees(entity.position.longitude, entity.position.latitude, entity.position.altitudeMeters),
        width: selected ? iconSize * 1.35 : iconSize,
        height: selected ? iconSize * 1.35 : iconSize,
        rotation: Cesium.Math.toRadians(-Number(entity.properties.trackDeg ?? 0)),
        color: this.colorFor(entity, selected),
        disableDepthTestDistance: 3_000_000,
      });
      this.billboards.set(entity.id, billboard);
    }

    this.stats.count = filtered.length;
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
          text: `${isMilitary(entity) ? 'MIL · ' : ''}${entity.name}`,
          font: '11px sans-serif',
          fillColor: isMilitary(entity) ? Cesium.Color.fromCssColorString('#fef08a') : Cesium.Color.fromCssColorString('#cffafe'),
          pixelOffset: new Cesium.Cartesian2(13, -13),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#111827').withAlpha(0.72),
        });
        this.selectedLabelId = entity.id;
      } else {
        this.selectedLabel.id = entity;
        this.selectedLabel.position = position;
        this.selectedLabel.text = `${isMilitary(entity) ? 'MIL · ' : ''}${entity.name}`;
      }
    }
    if (!updateBillboards) return;
    for (const [id, billboard] of this.billboards) {
      const record = this.records.get(id);
      if (!record) continue;
      billboard.color = this.colorFor(record, id === this.selectedId);
    }
  }

  private appendObservedTrail(entity: SpatialEntity) {
    if (entity.id !== this.selectedId) return;
    const last = this.observedTrail[this.observedTrail.length - 1];
    if (!last || Math.abs(last.latitude - entity.position.latitude) > 0.0001 || Math.abs(last.longitude - entity.position.longitude) > 0.0001) {
      this.observedTrail.push({ ...entity.position });
      while (this.observedTrail.length > 120) this.observedTrail.shift();
    }
  }

  private updateTrailAndTracker(projected: { longitude: number; latitude: number; altitudeMeters: number }) {
    if (!this.context) return;
    const { Cesium, viewer } = this.context;
    const selected = this.selectedId ? this.records.get(this.selectedId) : null;
    if (this.selectedId && this.observedTrail.length > 1) {
      const positions = this.observedTrail.map((item) => Cesium.Cartesian3.fromDegrees(item.longitude, item.latitude, item.altitudeMeters));
      const color = selected && isMilitary(selected) ? '#facc15' : '#67e8f9';
      if (!this.trailEntity) {
        this.trailEntity = viewer.entities.add({
          id: '__runtime:aircraft-trail',
          polyline: {
            positions,
            width: 2.5,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(color).withAlpha(0.72)),
            clampToGround: false,
          },
        });
      } else {
        this.trailEntity.polyline.positions = new Cesium.ConstantProperty(positions);
        this.trailEntity.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(color).withAlpha(0.72));
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
      const projected = projectAircraftPosition(entity, atMs);
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
    this.interpolationTimer = window.setInterval(() => this.tick(), INTERPOLATION_MS);
  }

  private scheduleRefresh(delay = REFRESH_MS) {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    if (!this.stats.enabled || this.destroyed) return;
    this.refreshTimer = window.setTimeout(() => void this.refresh(false), delay);
  }

  private replaceSourceStore(source: 'civilian' | 'military', snapshot: { entities: SpatialEntity[]; meta: AircraftFeedMeta }) {
    const next = new Map<string, SpatialEntity>();
    for (const item of snapshot.entities.slice(0, BUDGETS.maxMaterializedRecords)) next.set(item.id, item);
    if (source === 'civilian') {
      this.civilianRecords = next;
      this.civilianMeta = snapshot.meta;
    } else {
      this.militaryRecords = next;
      this.militaryMeta = snapshot.meta;
    }
  }

  private rebuildMergedRecords() {
    const next = new Map<string, SpatialEntity>();
    for (const item of this.civilianRecords.values()) next.set(item.id, item);
    for (const item of this.militaryRecords.values()) {
      const existing = next.get(item.id);
      if (existing) {
        const existingTime = Date.parse(existing.observedAt);
        const militaryTime = Date.parse(item.observedAt);
        const base = militaryTime >= existingTime ? item : existing;
        next.set(item.id, {
          ...base,
          properties: { ...existing.properties, ...item.properties, military: true },
        });
      } else {
        next.set(item.id, item);
      }
    }
    this.records = new Map(Array.from(next.entries()).slice(0, BUDGETS.maxMaterializedRecords));
    this.lastMilitaryCount = Array.from(this.records.values()).filter(isMilitary).length;
    this.lastMeta = this.civilianMeta ?? this.militaryMeta ?? null;
    if (this.selectedId) {
      const selected = this.records.get(this.selectedId);
      if (selected) this.appendObservedTrail(selected);
      else this.select(null);
    }
    this.rebuildVisibleCohort();
  }

  private updateCoverageVisual(meta: AircraftFeedMeta | null) {
    if (!this.context) return;
    const { Cesium, viewer } = this.context;
    if (this.coverageEntity) {
      viewer.entities.remove(this.coverageEntity);
      this.coverageEntity = null;
    }
    if (!this.stats.enabled || !this.sceneActive || !meta || meta.coverage !== 'regional' || !meta.region) return;
    const radiusMeters = Math.max(25, Math.min(250, meta.region.radiusNm)) * 1852;
    this.coverageEntity = viewer.entities.add({
      id: '__runtime:aircraft-regional-coverage',
      position: Cesium.Cartesian3.fromDegrees(meta.region.longitude, meta.region.latitude),
      ellipse: {
        semiMajorAxis: radiusMeters,
        semiMinorAxis: radiusMeters,
        height: 500,
        material: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.025),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.30),
        outlineWidth: 1,
      },
    });
  }

  private mergeSnapshots(civilian: { entities: SpatialEntity[]; meta: AircraftFeedMeta } | null, military: { entities: SpatialEntity[]; meta: AircraftFeedMeta } | null) {
    // Each source owns its own last-good store. A successful military refresh must
    // never replace retained civilian aircraft, and a regional civilian fallback
    // must never erase the global military cohort. This is the core ALL contract.
    if (civilian?.entities.length) this.replaceSourceStore('civilian', civilian);
    if (military?.entities.length) this.replaceSourceStore('military', military);
    this.rebuildMergedRecords();
    this.updateCoverageVisual(this.civilianMeta);
  }

  private async refresh(initial: boolean) {
    if (!this.context || !this.stats.enabled || this.destroyed) return;
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.stats.lastAttemptAt = new Date().toISOString();
    if (initial && !this.records.size) {
      this.connectStartedAt ??= Date.now();
      this.stats.state = 'loading';
      this.stats.error = 'Connecting to ADS-B providers…';
      if (!this.civilianRecords.size) this.civilianHealthState = 'loading';
      if (!this.militaryRecords.size) this.militaryHealthState = 'loading';
      this.civilianHealthError = null;
      this.militaryHealthError = null;
    } else {
      this.stats.error = null;
    }
    this.publish();

    const civilianPromise = fetchAircraftSnapshot({
      latitude: this.query.latitude,
      longitude: this.query.longitude,
      radiusNm: this.query.radiusNm,
      scope: this.query.scope,
    }, signal);
    const militaryPromise = fetchMilitarySnapshot(signal);

    const [civilianResult, militaryResult] = await Promise.allSettled([civilianPromise, militaryPromise]);
    if (this.destroyed || !this.stats.enabled || signal.aborted) return;

    const civilian = civilianResult.status === 'fulfilled' && civilianResult.value.entities.length ? civilianResult.value : null;
    const military = militaryResult.status === 'fulfilled' && militaryResult.value.entities.length ? militaryResult.value : null;
    const civilianError = civilianResult.status === 'rejected'
      ? (civilianResult.reason instanceof Error ? civilianResult.reason.message : 'civilian provider unavailable')
      : civilianResult.value.entities.length ? null : 'civilian provider returned no positioned aircraft';
    const militaryError = militaryResult.status === 'rejected'
      ? (militaryResult.reason instanceof Error ? militaryResult.reason.message : 'military provider unavailable')
      : militaryResult.value.entities.length ? null : 'military provider returned no positioned aircraft';

    if (civilian) {
      this.civilianHealthState = civilian.meta.stale || civilian.meta.degraded ? 'degraded' : 'live';
      this.civilianHealthError = civilian.meta.stale || civilian.meta.degraded ? 'Civilian feed is serving stale/degraded data' : null;
    } else if (this.civilianRecords.size) {
      this.civilianHealthState = 'degraded';
      this.civilianHealthError = `${civilianError ?? 'Civilian provider unavailable'} · retaining last-good`;
    }
    if (military) {
      this.militaryHealthState = military.meta.stale || military.meta.degraded ? 'degraded' : 'live';
      this.militaryHealthError = military.meta.stale || military.meta.degraded ? 'Military feed is serving stale/degraded data' : null;
    } else if (this.militaryRecords.size) {
      this.militaryHealthState = 'degraded';
      this.militaryHealthError = `${militaryError ?? 'Military provider unavailable'} · retaining last-good`;
    }

    if (!(civilian || military)) {
      const message = [civilianError, militaryError].filter(Boolean).join(' · ') || 'No positioned aircraft returned';
      const hasLastGood = this.civilianRecords.size > 0 || this.militaryRecords.size > 0;
      if (hasLastGood) {
        this.rebuildMergedRecords();
        this.stats.state = 'degraded';
        this.stats.error = `${message} · retaining ${this.civilianRecords.size} civilian + ${this.militaryRecords.size} military last-good records`;
        this.publish();
        this.scheduleRefresh(REFRESH_MS);
        return;
      }

      this.connectStartedAt ??= Date.now();
      const connecting = Date.now() - this.connectStartedAt < CONNECT_GRACE_MS;
      this.stats.state = connecting ? 'loading' : 'unavailable';
      this.stats.error = connecting ? `${message} · still connecting, retrying` : message;
      if (!this.civilianRecords.size) {
        this.civilianHealthState = connecting ? 'loading' : 'unavailable';
        this.civilianHealthError = civilianError;
      }
      if (!this.militaryRecords.size) {
        this.militaryHealthState = connecting ? 'loading' : 'unavailable';
        this.militaryHealthError = militaryError;
      }
      if (!connecting) this.lastMeta = null;
      this.publish();
      this.scheduleRefresh(connecting ? CONNECT_RETRY_MS : REFRESH_MS);
      return;
    }

    const retainedCivilian = !civilian && this.civilianRecords.size > 0;
    const retainedMilitary = !military && this.militaryRecords.size > 0;
    this.mergeSnapshots(civilian, military);
    if (this.records.size) this.connectStartedAt = null;

    const requestedGlobal = this.query.scope === 'global';
    const civilianGlobal = this.civilianMeta?.coverage === 'worldwide';
    const anyStale = Boolean(
      this.civilianMeta?.stale || this.civilianMeta?.degraded ||
      this.militaryMeta?.stale || this.militaryMeta?.degraded ||
      retainedCivilian || retainedMilitary,
    );
    const incompleteGlobal = requestedGlobal && !civilianGlobal;
    const degraded = anyStale || incompleteGlobal || Boolean(civilianError) || Boolean(militaryError);
    this.stats.state = degraded ? 'degraded' : 'live';
    this.stats.lastSuccessAt = new Date().toISOString();
    const hasCivilian = this.civilianRecords.size > 0;
    const hasMilitary = this.militaryRecords.size > 0;
    this.stats.provenance = {
      provider: hasCivilian
        ? `${this.civilianMeta?.provider ?? 'civilian ADS-B'}${hasMilitary ? ' + adsb.lol military' : ''}`
        : 'adsb.lol military',
      coverage: civilianGlobal ? 'worldwide' : this.civilianMeta?.coverage ?? 'worldwide',
      observedAt: this.stats.lastSuccessAt,
      sourceAgeSeconds: this.civilianMeta?.sourceAgeSeconds ?? this.militaryMeta?.sourceAgeSeconds ?? null,
      cached: Boolean(this.civilianMeta?.cached || this.militaryMeta?.cached || retainedCivilian || retainedMilitary),
      authMode: this.civilianMeta?.authMode ?? null,
    };
    const notes: string[] = [];
    if (incompleteGlobal) notes.push('Worldwide civilian feed unavailable; showing retained/regional civilian + global military where available');
    if (civilianError) notes.push(`${civilianError}${retainedCivilian ? ' · retaining civilian last-good' : ''}`);
    if (militaryError) notes.push(`Military: ${militaryError}${retainedMilitary ? ' · retaining military last-good' : ''}`);
    if (anyStale && !notes.length) notes.push('keeping last-good/stale provider data');
    if (degraded) notes.push(`ALL currently ${this.civilianRecords.size} civilian + ${this.militaryRecords.size} military before dedupe`);
    this.stats.error = degraded ? notes.filter(Boolean).join(' · ') || 'Provider degraded' : null;
    this.publish();
    this.scheduleRefresh(REFRESH_MS);
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
    this.connectStartedAt = null;
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
    if (this.coverageEntity && this.context) this.context.viewer.entities.remove(this.coverageEntity);
    this.coverageEntity = null;
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.records.size); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.collection) this.collection.show = active && this.stats.enabled;
    if (this.labels) this.labels.show = active && this.stats.enabled;
    if (active && this.stats.enabled) {
      this.updateCoverageVisual(this.civilianMeta);
      this.tick();
    } else if (!active && this.coverageEntity && this.context) {
      this.context.viewer.entities.remove(this.coverageEntity);
      this.coverageEntity = null;
    }
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
      this.cameraRefreshTimer = window.setTimeout(() => void this.refresh(false), 350);
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
    this.civilianRecords.clear();
    this.militaryRecords.clear();
    this.civilianHealthState = 'idle';
    this.militaryHealthState = 'idle';
    this.civilianHealthError = null;
    this.militaryHealthError = null;
    this.civilianMeta = null;
    this.militaryMeta = null;
    this.billboards.clear();
    this.context = null;
  }
}
