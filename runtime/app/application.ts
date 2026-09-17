import type { CesiumCameraPose } from '@/lib/camera';
import { captureCameraPose, restoreCameraPose } from '@/lib/camera';
import type { SpatialEntity } from '@/lib/spatial';
import type { RoutePoint, RouteResult } from '@/lib/directions';
import { AircraftLayer } from '@/runtime/layers/aircraft';
import { EarthquakeLayer } from '@/runtime/layers/earthquakes';
import { SatelliteLayer } from '@/runtime/layers/satellites';
import { TrafficLayer } from '@/runtime/layers/traffic';
import { MapStackController } from '@/runtime/maps/controller';
import type { CameraView, RuntimeLayerId, RuntimeSnapshot } from '@/runtime/types';
import { CameraService } from '@/runtime/app/camera-service';
import { LayerManager } from '@/runtime/app/layer-manager';
import { RenderGovernor } from '@/runtime/app/render-governor';
import { RouteService } from '@/runtime/app/route-service';

export type WorldRuntimeOptions = {
  Cesium: any;
  container: HTMLElement;
  googleMapsApiKey?: string;
};

type Annotation = { id: string; latitude: number; longitude: number; label: string };

export class WorldSelectRuntime {
  readonly viewer: any;
  private Cesium: any;
  private governor: RenderGovernor;
  private cameraService: CameraService;
  private mapStack: MapStackController;
  private routeService: RouteService;
  private layers = new LayerManager();
  private listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private selected: SpatialEntity | null = null;
  private hovered: SpatialEntity | null = null;
  private hoveredScreen: { x: number; y: number } | null = null;
  private followAircraft = false;
  private camera: CameraView = { latitude: 48.2082, longitude: 16.3738, height: 9_500_000, moving: false };
  private sceneActive = true;
  private clickHandler: any;
  private mapPointCapture: ((point: RoutePoint) => void) | null = null;
  private annotations = new Map<string, any>();
  private destroyed = false;

  constructor(options: WorldRuntimeOptions) {
    this.Cesium = options.Cesium;
    this.Cesium.Ion.defaultAccessToken = undefined;
    this.viewer = new this.Cesium.Viewer(options.container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new this.Cesium.EllipsoidTerrainProvider(),
      baseLayer: false,
      shouldAnimate: false,
    });

    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    this.viewer.scene.backgroundColor = this.Cesium.Color.fromCssColorString('#020617');
    this.viewer.camera.setView({ destination: this.Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000) });

    this.governor = new RenderGovernor(this.viewer);
    this.routeService = new RouteService(this.Cesium, this.viewer, () => this.governor.request());
    this.mapStack = new MapStackController(this.Cesium, this.viewer, options.googleMapsApiKey ?? '', () => this.emit());

    const context = {
      Cesium: this.Cesium,
      viewer: this.viewer,
      requestRender: () => this.governor.request(),
      isSceneActive: () => this.sceneActive && this.governor.isActive(),
      onStatsChanged: () => this.emit(),
    };

    const earthquakes = new EarthquakeLayer();
    const satellites = new SatelliteLayer();
    const aircraft = new AircraftLayer();
    const traffic = new TrafficLayer();
    for (const layer of [earthquakes, satellites, aircraft, traffic]) {
      this.layers.register(layer);
      layer.init(context);
    }

    this.cameraService = new CameraService(this.Cesium, this.viewer, (view) => this.handleCamera(view));
    this.clickHandler = new this.Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.clickHandler.setInputAction((movement: any) => this.handlePick(movement.position), this.Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this.clickHandler.setInputAction((movement: any) => this.handleHover(movement.endPosition), this.Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    void this.mapStack.initialize();
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private emit() {
    if (this.destroyed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private handleCamera(view: CameraView) {
    this.layers.onCameraChanged(view);
    this.camera = view;
    if (!view.moving) this.emit();
  }

  private pickedEntity(position: any): SpatialEntity | null {
    if (!position) return null;
    const picked = this.viewer.scene.pick(position);
    const raw = picked?.id;
    if (raw && typeof raw === 'object' && typeof raw.id === 'string' && typeof raw.kind === 'string') return raw as SpatialEntity;
    if (typeof raw === 'string') return this.layers.resolveEntity(raw);
    return null;
  }

  private handleHover(position: any) {
    if (this.mapPointCapture || !position) return;
    const entity = this.pickedEntity(position);
    const nextId = entity?.id ?? null;
    if ((this.hovered?.id ?? null) === nextId) return;
    this.hovered = entity;
    this.hoveredScreen = entity
      ? { x: Number(position.x) || 0, y: Number(position.y) || 0 }
      : null;
    this.emit();
  }

  private handlePick(position: any) {
    if (this.mapPointCapture) {
      const cartesian = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
      if (cartesian) {
        const cartographic = this.Cesium.Cartographic.fromCartesian(cartesian);
        const point = {
          latitude: this.Cesium.Math.toDegrees(cartographic.latitude),
          longitude: this.Cesium.Math.toDegrees(cartographic.longitude),
        };
        const capture = this.mapPointCapture;
        this.mapPointCapture = null;
        capture(point);
        return;
      }
    }
    const entity = this.pickedEntity(position);
    if (!entity) return;
    this.select(entity);
  }

  getSnapshot(): RuntimeSnapshot {
    const map = this.mapStack.getStatus();
    return {
      camera: { ...this.camera },
      selected: this.selected ? { ...this.selected, position: { ...this.selected.position }, properties: { ...this.selected.properties } } : null,
      hovered: this.hovered ? { ...this.hovered, position: { ...this.hovered.position }, properties: { ...this.hovered.properties } } : null,
      hoveredScreen: this.hoveredScreen ? { ...this.hoveredScreen } : null,
      followAircraft: this.followAircraft,
      mapSource: map.source,
      mapError: map.error,
      layers: this.layers.stats(),
    };
  }

  async setLayerEnabled(id: RuntimeLayerId, enabled: boolean) {
    if (enabled) await this.layers.enable(id);
    else this.layers.disable(id);
    if (!enabled && this.selected && this.layerForEntity(this.selected) === id) this.select(null);
    this.emit();
  }

  async retryLayer(id: RuntimeLayerId) {
    await this.layers.retry(id);
    this.emit();
  }

  setSatelliteCatalog(catalog: 'core' | 'dense') {
    this.layers.get<SatelliteLayer>('satellites').setCatalog(catalog);
    this.emit();
  }

  getSatelliteCatalog() {
    return this.layers.get<SatelliteLayer>('satellites').getCatalog();
  }

  setAircraftDisplayMode(mode: 'all' | 'civilian' | 'military') {
    this.layers.get<AircraftLayer>('aircraft').setDisplayMode(mode);
    this.emit();
  }

  getAircraftMilitaryCount() {
    return this.layers.get<AircraftLayer>('aircraft').getMilitaryCount();
  }

  captureNextMapPoint(handler: (point: RoutePoint) => void) {
    this.mapPointCapture = handler;
  }

  cancelMapPointCapture() {
    this.mapPointCapture = null;
  }

  showRoute(a: RoutePoint, b: RoutePoint, route: RouteResult) {
    this.routeService.showRoute(a, b, route);
  }

  flyRoute(route: RouteResult) {
    this.routeService.fly(route);
  }

  clearRoute() {
    this.mapPointCapture = null;
    this.routeService.clear(true);
  }

  setTimeOffsetDays(days: number) {
    const satelliteLayer = this.layers.get<SatelliteLayer>('satellites');
    satelliteLayer.setTime(days === 0 ? null : new Date(Date.now() + days * 86_400_000));
    if (days !== 0) {
      this.layers.disable('aircraft');
      this.followAircraft = false;
    }
    this.emit();
  }

  setSceneActive(active: boolean) {
    this.sceneActive = active;
    this.governor.setApplicationActive(active);
    this.layers.setSceneActive(active);
    if (active) this.governor.request();
  }

  flyEarth() {
    const view = this.cameraService.readView(false) ?? this.camera;
    this.setSceneActive(true);
    this.cameraService.flyTo(view.latitude, view.longitude, 6_500_000, -90, 1.0);
  }

  flyGround() {
    const view = this.cameraService.readView(false) ?? this.camera;
    this.setSceneActive(true);
    this.cameraService.flyTo(view.latitude, view.longitude, 8_000, -48, 1.2);
  }

  focusSelected() {
    if (!this.selected || this.selected.kind === 'celestial-body') return;
    const height = this.selected.kind === 'satellite'
      ? Math.max(1_000_000, this.selected.position.altitudeMeters * 1.8)
      : this.selected.kind === 'aircraft' ? 180_000 : 700_000;
    this.cameraService.flyTo(this.selected.position.latitude, this.selected.position.longitude, height, -90, 1.2);
  }

  select(entity: SpatialEntity | null) {
    this.selected = entity;
    this.layers.select(entity);
    if (!entity || entity.kind !== 'aircraft') {
      this.followAircraft = false;
      this.layers.get<AircraftLayer>('aircraft').setFollowing(null);
    }
    this.emit();
  }

  setFollowAircraft(enabled: boolean) {
    if (!enabled || this.selected?.kind !== 'aircraft') {
      this.followAircraft = false;
      this.layers.get<AircraftLayer>('aircraft').setFollowing(null);
    } else {
      this.followAircraft = true;
      this.layers.get<AircraftLayer>('aircraft').setFollowing(this.selected.id);
    }
    this.emit();
  }

  private layerForEntity(entity: SpatialEntity): RuntimeLayerId | null {
    if (entity.kind === 'earthquake') return 'earthquakes';
    if (entity.kind === 'satellite') return 'satellites';
    if (entity.kind === 'aircraft') return 'aircraft';
    return null;
  }

  captureCameraPose(): CesiumCameraPose | null { return captureCameraPose(this.viewer); }

  restoreCameraPose(pose: CesiumCameraPose | null) {
    restoreCameraPose(this.viewer, this.Cesium, pose);
    this.governor.request();
  }

  getViewCenter() {
    const view = this.cameraService.readView(false) ?? this.camera;
    return { latitude: view.latitude, longitude: view.longitude };
  }

  setAnnotations(items: Annotation[]) {
    const live = new Set<string>();
    for (const item of items) {
      const id = `annotation:${item.id}`;
      live.add(id);
      if (this.annotations.has(id)) continue;
      const entity = this.viewer.entities.add({
        id,
        position: this.Cesium.Cartesian3.fromDegrees(item.longitude, item.latitude, 15),
        point: {
          pixelSize: 10,
          color: this.Cesium.Color.fromCssColorString('#fb923c'),
          outlineColor: this.Cesium.Color.WHITE,
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: item.label,
          font: '11px sans-serif',
          fillColor: this.Cesium.Color.WHITE,
          pixelOffset: new this.Cesium.Cartesian2(10, -11),
          showBackground: true,
          backgroundColor: this.Cesium.Color.fromCssColorString('#111827').withAlpha(0.72),
        },
      });
      this.annotations.set(id, entity);
    }
    for (const [id, entity] of this.annotations) {
      if (live.has(id)) continue;
      this.viewer.entities.remove(entity);
      this.annotations.delete(id);
    }
    this.governor.request();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.clickHandler?.destroy?.();
    this.layers.destroy();
    this.routeService.destroy();
    this.mapStack.destroy();
    this.cameraService.destroy();
    this.governor.destroy();
    for (const entity of this.annotations.values()) this.viewer.entities.remove(entity);
    this.annotations.clear();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
