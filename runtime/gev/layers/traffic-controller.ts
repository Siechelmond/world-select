import { fetchTrafficStatus, type TrafficStatus } from '@/lib/traffic';
import {
  advanceModeledVehicles,
  buildModeledFlows,
  fetchRoads,
  generateModeledVehicles,
  getCongestionColor,
  type FlowSegment,
  type ModeledVehicle,
  type RoadSegment,
} from '@/lib/traffic-vector';
import type { LayerLoadState } from '@/lib/layer-runtime';

type Context = {
  enabled: boolean;
  earthVisible: boolean;
  latitude: number;
  longitude: number;
  cameraHeight: number;
  mapMode: "photoreal" | "satellite" | "map" | "nasa";
};

type RuntimeState = {
  state: LayerLoadState;
  status: TrafficStatus | null;
  error?: string;
  vehicleCount: number;
};

/**
 * GEV-style traffic owner: live TomTom imagery starts immediately while source
 * status is checked in parallel. OSM geometry + modeled vehicles are an isolated
 * city fallback, not the primary traffic truth.
 */
export function createTrafficController(input: {
  viewer: any;
  Cesium: any;
  onState: (value: RuntimeState) => void;
}) {
  const { viewer, Cesium, onState } = input;
  let context: Context = {
    enabled: false,
    earthVisible: true,
    latitude: 0,
    longitude: 0,
    cameraHeight: Number.POSITIVE_INFINITY,
    mapMode: "satellite",
  };
  let status: TrafficStatus | null = null;
  let flowLayer: any = null;
  let incidentLayer: any = null;
  let flowProvider: any = null;
  let incidentProvider: any = null;
  let statusController: AbortController | null = null;
  let vectorController: AbortController | null = null;
  let roadCollection: any = null;
  let groundRoadPrimitives: any[] = [];
  let vehicleCollection: any = null;
  let vehicleTimer: ReturnType<typeof setInterval> | null = null;
  let fallbackKey: string | null = null;
  let liveFailed = false;
  let destroyed = false;
  let vehicleCount = 0;

  const publish = (state: LayerLoadState, error?: string) => {
    onState({ state, status, error, vehicleCount });
  };

  const clearVector = () => {
    vectorController?.abort();
    vectorController = null;
    if (vehicleTimer) clearInterval(vehicleTimer);
    vehicleTimer = null;
    if (vehicleCollection) {
      try { viewer.scene.primitives.remove(vehicleCollection); } catch {}
    }
    if (roadCollection) {
      try { viewer.scene.primitives.remove(roadCollection); } catch {}
    }
    for (const primitive of groundRoadPrimitives) {
      try { viewer.scene.groundPrimitives.remove(primitive); } catch {}
    }
    groundRoadPrimitives = [];
    vehicleCollection = null;
    roadCollection = null;
    fallbackKey = null;
    vehicleCount = 0;
    viewer.scene?.requestRender?.();
  };

  const onTileError = (error: any) => {
    if (destroyed || !context.enabled || !context.earthVisible) return;
    liveFailed = true;
    const http = Number(error?.statusCode ?? 0);
    publish(
      'degraded',
      http
        ? `Traffic tile request failed (HTTP ${http}) · switching to city fallback`
        : 'Traffic tile refresh delayed · switching to city fallback',
    );
    void ensureFallback();
  };

  const mountLive = () => {
    if (flowLayer || destroyed || !context.enabled || !context.earthVisible || context.mapMode === "photoreal") return;
    flowProvider = new Cesium.UrlTemplateImageryProvider({
      url: '/api/traffic?z={z}&x={x}&y={y}',
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: 'Traffic © TomTom',
    });
    flowProvider.errorEvent?.addEventListener(onTileError);
    flowLayer = viewer.imageryLayers.addImageryProvider(flowProvider);
    flowLayer.alpha = 1;
    flowLayer.brightness = 1.08;
    flowLayer.contrast = 1.12;

    incidentProvider = new Cesium.UrlTemplateImageryProvider({
      url: '/api/traffic?kind=incidents&z={z}&x={x}&y={y}',
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: 'Traffic incidents © TomTom',
    });
    incidentProvider.errorEvent?.addEventListener(onTileError);
    incidentLayer = viewer.imageryLayers.addImageryProvider(incidentProvider);
    incidentLayer.alpha = 0.7;
    viewer.scene?.requestRender?.();
  };

  const unmountLive = () => {
    flowProvider?.errorEvent?.removeEventListener(onTileError);
    incidentProvider?.errorEvent?.removeEventListener(onTileError);
    flowProvider = null;
    incidentProvider = null;
    if (flowLayer) {
      try { viewer.imageryLayers.remove(flowLayer, true); } catch {}
    }
    if (incidentLayer) {
      try { viewer.imageryLayers.remove(incidentLayer, true); } catch {}
    }
    flowLayer = null;
    incidentLayer = null;
  };

  const vectorKey = () => {
    const bucket = context.cameraHeight < 35_000 ? 'near' : 'city';
    return `${context.latitude.toFixed(2)}:${context.longitude.toFixed(2)}:${bucket}:${context.mapMode}`;
  };

  async function ensureFallback() {
    const shouldFallback =
      !destroyed &&
      context.enabled &&
      context.earthVisible &&
      context.cameraHeight < 180_000 &&
      (context.mapMode === "photoreal" || liveFailed || (status != null && (!status.configured || !status.available)));

    if (!shouldFallback) {
      clearVector();
      return;
    }

    const key = vectorKey();
    if (fallbackKey === key && (roadCollection || groundRoadPrimitives.length || vehicleCollection || vectorController)) return;
    clearVector();
    fallbackKey = key;
    const controller = new AbortController();
    vectorController = controller;
    publish('loading');

    let roads: RoadSegment[] = [];
    let flows: FlowSegment[] = [];
    let vehicles: ModeledVehicle[] = [];
    const photoreal = context.mapMode === "photoreal";
    roadCollection = photoreal ? null : new Cesium.PolylineCollection();
    vehicleCollection = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    if (roadCollection) viewer.scene.primitives.add(roadCollection);
    viewer.scene.primitives.add(vehicleCollection);

    const renderVehicles = () => {
      if (!vehicleCollection || destroyed) return;
      vehicleCollection.removeAll();
      const flowMap = new Map(flows.map((item) => [item.roadId, item]));
      for (const vehicle of vehicles) {
        const flow = flowMap.get(vehicle.roadId);
        vehicleCollection.add({
          position: Cesium.Cartesian3.fromDegrees(
            vehicle.position.longitude,
            vehicle.position.latitude,
            8,
          ),
          pixelSize: context.cameraHeight < 30_000 ? 4 : 3,
          color: Cesium.Color.fromCssColorString(
            getCongestionColor(flow?.congestion ?? 'free-flow'),
          ),
          outlineColor: Cesium.Color.fromCssColorString('#020617'),
          outlineWidth: 1,
          disableDepthTestDistance: 5_000,
        });
      }
      viewer.scene?.requestRender?.();
    };

    try {
      const nextRoads = await fetchRoads(
        context.latitude,
        context.longitude,
        context.cameraHeight < 35_000 ? 5 : 8,
        controller.signal,
      );
      if (controller.signal.aborted || destroyed) return;
      roads = nextRoads.slice(0, 500);
      flows = buildModeledFlows(roads);
      vehicles = generateModeledVehicles(roads, flows, 260);
      vehicleCount = vehicles.length;
      const flowMap = new Map(flows.map((flow) => [flow.roadId, flow]));
      if (photoreal && Cesium.GroundPolylinePrimitive?.isSupported?.(viewer.scene)) {
        const groups = new Map<string, any[]>();
        for (const road of roads) {
          if (road.coordinates.length < 2) continue;
          const congestion = flowMap.get(road.id)?.congestion ?? 'free-flow';
          const list = groups.get(congestion) ?? [];
          list.push(new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
              width: road.highway === 'motorway' || road.highway === 'trunk' ? 4 : 2.5,
            }),
          }));
          groups.set(congestion, list);
        }
        for (const [congestion, instances] of groups) {
          if (!instances.length) continue;
          const primitive = viewer.scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
            geometryInstances: instances,
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
            appearance: new Cesium.PolylineMaterialAppearance({
              material: Cesium.Material.fromType('PolylineGlow', {
                color: Cesium.Color.fromCssColorString(getCongestionColor(congestion as any)).withAlpha(0.88),
                glowPower: 0.18,
              }),
            }),
          }));
          groundRoadPrimitives.push(primitive);
        }
      } else if (roadCollection) {
        for (const road of roads) {
          if (road.coordinates.length < 2) continue;
          roadCollection.add({
            positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 5)),
            width: road.highway === 'motorway' || road.highway === 'trunk' ? 3 : 2,
            material: Cesium.Material.fromType('Color', {
              color: Cesium.Color.fromCssColorString(
                getCongestionColor(flowMap.get(road.id)?.congestion ?? 'free-flow'),
              ).withAlpha(0.82),
            }),
          });
        }
      }
      renderVehicles();
      publish(
        roads.length ? 'degraded' : 'error',
        roads.length
          ? (photoreal
              ? '3D traffic overlay · OSM road geometry + modeled vehicles on Google 3D tiles'
              : 'OSM road geometry + modeled vehicle fallback · live TomTom unavailable')
          : 'No OSM road geometry returned for this viewport',
      );
      if (vehicles.length) {
        vehicleTimer = setInterval(() => {
          vehicles = advanceModeledVehicles(vehicles, roads, flows, 0.25);
          renderVehicles();
        }, 250);
      }
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      publish('error', error instanceof Error ? error.message : 'OSM road geometry unavailable');
    } finally {
      if (vectorController === controller) vectorController = null;
    }
  }

  const refreshStatus = async () => {
    statusController?.abort();
    const controller = new AbortController();
    statusController = controller;
    publish('loading');
    try {
      const next = await fetchTrafficStatus(controller.signal);
      if (controller.signal.aborted || destroyed) return;
      status = next;
      if (next.configured && next.available && !liveFailed && context.mapMode !== 'photoreal') {
        clearVector();
        publish('ready');
      } else {
        publish(
          'degraded',
          context.mapMode === 'photoreal'
            ? '3D traffic uses OSM road geometry + modeled vehicles over Google 3D tiles'
            : 'Live TomTom flow unavailable · OSM road geometry + modeled vehicles available as city fallback',
        );
        void ensureFallback();
      }
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      status = null;
      publish(
        'degraded',
        error instanceof Error
          ? `${error.message} · OSM road geometry + modeled vehicles available as city fallback`
          : 'Live traffic status unavailable · OSM road geometry + modeled vehicles available as city fallback',
      );
      liveFailed = true;
      void ensureFallback();
    } finally {
      if (statusController === controller) statusController = null;
    }
  };

  return Object.freeze({
    sync(next: Context) {
      const wasActive = context.enabled && context.earthVisible;
      const previousKey = vectorKey();
      context = next;
      const active = context.enabled && context.earthVisible;

      if (!active) {
        statusController?.abort();
        statusController = null;
        unmountLive();
        clearVector();
        liveFailed = false;
        publish('idle');
        return;
      }

      if (context.mapMode === "photoreal") {
        unmountLive();
      } else {
        mountLive();
        if (status?.configured && status.available && !liveFailed) clearVector();
      }
      if (!wasActive || (!status && !statusController)) void refreshStatus();

      const nextKey = vectorKey();
      if (previousKey !== nextKey || context.mapMode === "photoreal") void ensureFallback();
      else if (liveFailed || (status && (!status.configured || !status.available))) void ensureFallback();
    },

    retry() {
      liveFailed = false;
      unmountLive();
      clearVector();
      if (context.enabled && context.earthVisible) {
        mountLive();
        void refreshStatus();
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      statusController?.abort();
      statusController = null;
      unmountLive();
      clearVector();
    },
  });
}
