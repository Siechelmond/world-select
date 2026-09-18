import { fetchTrafficStatus, type TrafficStatus } from '@/lib/traffic';
import {
  fetchRoads,
  buildModeledFlows,
  generateModeledVehicles,
  advanceModeledVehicles,
  getCongestionColor,
  type RoadSegment,
  type FlowSegment,
  type ModeledVehicle,
} from '@/lib/traffic-vector';
import type { SpatialEntity } from '@/lib/spatial';
import {
  createInitialLayerStats,
  type CameraView,
  type LayerContext,
  type RuntimeLayer,
  type RuntimeLayerStats,
} from '@/runtime/types';

const STATUS_REFRESH_MS = 120_000;
const VECTOR_REFRESH_MS = 60_000;
const VEHICLE_ANIMATION_MS = 100;
const BUDGETS = {
  maxMaterializedRecords: 0,
  maxVisibleGlyphs: 400,
  maxLabels: 0,
  max3DModels: 0,
  maxTrails: 0,
  maxExpensiveGeometry: 2,
};

type TrafficMode = 'raster' | 'vector' | 'hybrid';

export class TrafficLayer implements RuntimeLayer {
  readonly id = 'traffic' as const;
  private context: LayerContext | null = null;
  private stats: RuntimeLayerStats = createInitialLayerStats(this.id, BUDGETS);
  private flowLayer: any = null;
  private incidentLayer: any = null;
  private status: TrafficStatus | null = null;
  private timer: number | null = null;
  private vectorTimer: number | null = null;
  private vehicleTimer: number | null = null;
  private controller: AbortController | null = null;
  private vectorController: AbortController | null = null;
  private sceneActive = true;
  private destroyed = false;
  private tileErrorHandler: ((error: any) => void) | null = null;
  private mode: TrafficMode = 'raster';

  private roads: RoadSegment[] = [];
  private flows: FlowSegment[] = [];
  private vehicles: ModeledVehicle[] = [];
  private vehicleCollection: any = null;
  private roadPrimitiveCollection: any = null;
  private lastVehicleUpdate = 0;
  private lastCameraCenter: { lat: number; lon: number } | null = null;

  init(context: LayerContext) { this.context = context; }
  private publish() { this.context?.onStatsChanged(); }
  getProviderStatus() { return this.status; }
  getMode() { return this.mode; }

  private removeLayers() {
    if (!this.context) return;
    const layers = this.context.viewer.imageryLayers;
    if (this.flowLayer) layers.remove(this.flowLayer, true);
    if (this.incidentLayer) layers.remove(this.incidentLayer, true);
    this.flowLayer = null;
    this.incidentLayer = null;
    this.stats.visibleCount = 0;
  }

  private removeVectorLayers() {
    if (!this.context || !this.vehicleCollection) return;
    const { viewer } = this.context;
    try { viewer.scene.primitives.remove(this.vehicleCollection); } catch { /* removed */ }
    this.vehicleCollection = null;
    try { viewer.scene.primitives.remove(this.roadPrimitiveCollection); } catch { /* removed */ }
    this.roadPrimitiveCollection = null;
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

  private attachVectorLayers() {
    if (!this.context || this.vehicleCollection || !this.stats.enabled) return;
    const { Cesium, viewer } = this.context;
    this.vehicleCollection = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    viewer.scene.primitives.add(this.vehicleCollection);
    this.roadPrimitiveCollection = new Cesium.PolylineCollection();
    viewer.scene.primitives.add(this.roadPrimitiveCollection);
    this.renderRoads();
    this.renderVehicles();
  }

  private renderRoads() {
    if (!this.context || !this.roadPrimitiveCollection || !this.roads.length) return;
    const { Cesium } = this.context;
    this.roadPrimitiveCollection.removeAll();
    const flowMap = new Map(this.flows.map((f) => [f.roadId, f]));
    for (const road of this.roads) {
      const flow = flowMap.get(road.id);
      const color = Cesium.Color.fromCssColorString(getCongestionColor(flow?.congestion ?? 'free-flow'));
      const positions = road.coordinates.map(([lon, lat]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, 2),
      );
      if (positions.length < 2) continue;
      this.roadPrimitiveCollection.add({
        positions,
        width: road.highway === 'motorway' || road.highway === 'trunk' ? 3 : 2,
        material: Cesium.Material.fromType('Color', { color }),
        clampToGround: true,
      });
    }
    this.context.requestRender();
  }

  private renderVehicles() {
    if (!this.context || !this.vehicleCollection || !this.vehicles.length) return;
    const { Cesium } = this.context;
    this.vehicleCollection.removeAll();
    const flowMap = new Map(this.flows.map((f) => [f.roadId, f]));
    for (const v of this.vehicles) {
      const flow = flowMap.get(v.roadId);
      const color = Cesium.Color.fromCssColorString(getCongestionColor(flow?.congestion ?? 'free-flow'));
      this.vehicleCollection.add({
        position: Cesium.Cartesian3.fromDegrees(v.position.longitude, v.position.latitude, 5),
        pixelSize: 3,
        color,
        outlineColor: Cesium.Color.fromCssColorString('#020617'),
        outlineWidth: 1,
        disableDepthTestDistance: 5000,
      });
    }
    this.stats.count = this.vehicles.length;
    this.context.requestRender();
  }

  private animateVehicles() {
    if (!this.vehicleCollection || !this.vehicles.length || this.destroyed) return;
    const now = performance.now();
    const delta = this.lastVehicleUpdate > 0 ? (now - this.lastVehicleUpdate) / 1000 : 0.1;
    this.lastVehicleUpdate = now;
    this.vehicles = advanceModeledVehicles(this.vehicles, this.roads, this.flows, delta);
    this.renderVehicles();
  }

  private schedule() {
    if (this.timer != null) window.clearTimeout(this.timer);
    if (!this.stats.enabled || this.destroyed) return;
    this.timer = window.setTimeout(() => void this.refresh(false), STATUS_REFRESH_MS);
  }

  private scheduleVectorRefresh() {
    if (this.vectorTimer != null) window.clearTimeout(this.vectorTimer);
    if (!this.stats.enabled || this.destroyed || this.mode === 'raster') return;
    this.vectorTimer = window.setTimeout(() => void this.refreshVector(), VECTOR_REFRESH_MS);
  }

  private scheduleVehicleAnimation() {
    if (this.vehicleTimer != null) window.clearInterval(this.vehicleTimer);
    if (!this.stats.enabled || this.destroyed || !this.vehicleCollection) return;
    this.lastVehicleUpdate = performance.now();
    this.vehicleTimer = window.setInterval(() => this.animateVehicles(), VEHICLE_ANIMATION_MS);
  }

  private async refreshVector() {
    if (!this.context || !this.stats.enabled || this.destroyed || this.mode === 'raster') return;
    this.vectorController?.abort();
    this.vectorController = new AbortController();
    const view = this.lastCameraCenter ?? { lat: 48.2, lon: 16.3 };
    try {
      const roads = await fetchRoads(view.lat, view.lon, 8, this.vectorController.signal);
      if (this.destroyed || !this.stats.enabled || this.vectorController.signal.aborted) return;
      this.roads = roads;
      this.flows = buildModeledFlows(roads);
      this.vehicles = generateModeledVehicles(roads, this.flows, BUDGETS.maxVisibleGlyphs);
      if (!this.vehicleCollection) this.attachVectorLayers();
      else { this.renderRoads(); this.renderVehicles(); }
      this.scheduleVehicleAnimation();
      this.stats.state = 'live';
      this.stats.provenance = {
        provider: 'Overpass + modeled vehicles',
        coverage: 'viewport',
        observedAt: new Date().toISOString(),
        cached: false,
      };
      this.stats.error = 'Modeled vehicle positions are simulated, not observed live vehicles';
      this.publish();
    } catch (reason: unknown) {
      if (this.vectorController?.signal.aborted || this.destroyed) return;
      this.stats.state = this.vehicles.length ? 'degraded' : 'loading';
      this.stats.error = reason instanceof Error ? reason.message : 'Vector traffic refresh failed';
      this.publish();
    } finally {
      this.scheduleVectorRefresh();
    }
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
      if (!status.configured) {
        this.removeLayers();
        this.stats.state = 'unavailable';
        this.stats.error = status.message || 'Traffic source not configured';
        return;
      }

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
      this.attachLayers();
      this.stats.state = this.flowLayer ? 'degraded' : 'loading';
      this.stats.error = this.flowLayer
        ? `${message} · traffic tiles remain active and self-validate in the viewport`
        : `${message} · preparing traffic tiles`;
    } finally {
      this.publish();
      this.schedule();
    }
  }

  async enable() {
    this.stats.enabled = true;
    this.stats.state = this.flowLayer ? this.stats.state : 'loading';
    // Attach first, validate second. This lets Cesium start requesting the same
    // visible TomTom tiles that worked on main while the probe runs in parallel.
    this.attachLayers();
    if (this.flowLayer) this.flowLayer.show = this.sceneActive;
    if (this.incidentLayer) this.incidentLayer.show = this.sceneActive;
    this.publish();
    await this.refresh(false);
    if (this.status?.available) {
      this.mode = 'hybrid';
      await this.refreshVector();
    } else {
      this.mode = 'vector';
      await this.refreshVector();
    }
  }

  disable() {
    this.stats.enabled = false;
    this.stats.state = 'idle';
    this.controller?.abort();
    this.vectorController?.abort();
    if (this.timer != null) window.clearTimeout(this.timer);
    if (this.vectorTimer != null) window.clearTimeout(this.vectorTimer);
    if (this.vehicleTimer != null) window.clearInterval(this.vehicleTimer);
    this.timer = null;
    this.vectorTimer = null;
    this.vehicleTimer = null;
    this.removeLayers();
    this.removeVectorLayers();
    this.roads = [];
    this.flows = [];
    this.vehicles = [];
    this.publish();
    this.context?.requestRender();
  }

  retry() { return this.refresh(!this.flowLayer); }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    if (this.flowLayer) this.flowLayer.show = active && this.stats.enabled;
    if (this.incidentLayer) this.incidentLayer.show = active && this.stats.enabled;
    if (this.vehicleCollection) this.vehicleCollection.show = active && this.stats.enabled;
    if (this.roadPrimitiveCollection) this.roadPrimitiveCollection.show = active && this.stats.enabled;
    this.context?.requestRender();
  }

  onCameraChanged(view: CameraView) {
    const center = { lat: view.latitude, lon: view.longitude };
    const moved = !this.lastCameraCenter ||
      Math.abs(this.lastCameraCenter.lat - center.lat) > 0.05 ||
      Math.abs(this.lastCameraCenter.lon - center.lon) > 0.05;
    this.lastCameraCenter = center;
    if (moved && this.stats.enabled && this.mode !== 'raster' && view.height < 50_000) {
      void this.refreshVector();
    }
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
