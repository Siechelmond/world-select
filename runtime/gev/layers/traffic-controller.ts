import { fetchTrafficStatus, type TrafficStatus } from '@/lib/traffic';
import {
  buildModeledFlows,
  fetchRoads,
  generateModeledVehicles,
  getCongestionColor,
  type FlowSegment,
  type ModeledVehicle,
  type RoadSegment,
} from '@/lib/traffic-vector';
import type { LayerLoadState } from '@/lib/layer-runtime';
import { holdContinuousRender, releaseContinuousRender } from '@/runtime/gev/render-governor';
import { createTrafficMotionModel } from '@/runtime/gev/layers/traffic-motion';

type Context = {
  enabled: boolean;
  earthVisible: boolean;
  latitude: number;
  longitude: number;
  cameraHeight: number;
  mapMode: "photoreal" | "satellite" | "map" | "nasa";
};

function vehicleSvg(kind: "car" | "van" | "truck") {
  const body = kind === "truck"
    ? '<rect x="17" y="5" width="30" height="54" rx="6" fill="white"/><rect x="21" y="9" width="22" height="19" rx="3" fill="#020617"/><rect x="21" y="34" width="22" height="19" rx="3" fill="#020617"/>'
    : kind === "van"
      ? '<rect x="19" y="5" width="26" height="54" rx="9" fill="white"/><rect x="23" y="10" width="18" height="15" rx="3" fill="#020617"/><rect x="23" y="31" width="18" height="20" rx="3" fill="#020617"/>'
      : '<rect x="20" y="6" width="24" height="52" rx="10" fill="white"/><rect x="24" y="12" width="16" height="12" rx="3" fill="#020617"/><rect x="24" y="31" width="16" height="15" rx="3" fill="#020617"/>';
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;
}

const VEHICLE_ICONS = {
  car: vehicleSvg("car"),
  van: vehicleSvg("van"),
  truck: vehicleSvg("truck"),
};

function vehicleKind(index: number, road?: RoadSegment): "car" | "van" | "truck" {
  if (road?.highway === "motorway" || road?.highway === "trunk") {
    if (index % 9 === 0) return "truck";
    if (index % 5 === 0) return "van";
  }
  return index % 11 === 0 ? "van" : "car";
}

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
  let vehicleMotion: ReturnType<typeof createTrafficMotionModel> | null = null;
  let vehiclePreRenderRemover: (() => void) | null = null;
  let photorealHeightRebindRemover: (() => void) | null = null;
  let lastPhotorealHeightProbeMs = 0;
  let lastVehicleFrameMs = 0;

  // Traffic acquisition state is independent from camera zoom. Roads/flows/
  // modeled vehicles survive zoom and map-style changes until the view has
  // actually moved outside the cached local coverage.
  let dataCenter: { latitude: number; longitude: number } | null = null;
  let roads: RoadSegment[] = [];
  let flows: FlowSegment[] = [];
  let vehicles: ModeledVehicle[] = [];
  let renderedMode: Context["mapMode"] | null = null;
  let liveFailed = false;
  let destroyed = false;
  let vehicleCount = 0;

  const publish = (state: LayerLoadState, error?: string) => {
    onState({ state, status, error, vehicleCount });
  };

  const clearRenderedFallback = () => {
    vehiclePreRenderRemover?.();
    vehiclePreRenderRemover = null;
    photorealHeightRebindRemover?.();
    photorealHeightRebindRemover = null;
    lastPhotorealHeightProbeMs = 0;
    lastVehicleFrameMs = 0;
    releaseContinuousRender('traffic');
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
    vehicleMotion = null;
    roadCollection = null;
    renderedMode = null;
    viewer.scene?.requestRender?.();
  };

  const clearVector = () => {
    vectorController?.abort();
    vectorController = null;
    clearRenderedFallback();
    dataCenter = null;
    roads = [];
    flows = [];
    vehicles = [];
    vehicleCount = 0;
  };

  const distanceKm = (
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number },
  ) => {
    const toRad = (value: number) => value * Math.PI / 180;
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const dLat = lat2 - lat1;
    const dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
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

  const fallbackSourceNeeded = () =>
    context.mapMode === "photoreal" ||
    liveFailed ||
    (status != null && (!status.configured || !status.available));

  const fallbackVisible = () =>
    context.enabled &&
    context.earthVisible &&
    context.cameraHeight < (context.mapMode === "photoreal" ? 600_000 : 180_000) &&
    fallbackSourceNeeded();

  const renderFallback = () => {
    if (destroyed || !fallbackVisible() || !roads.length) {
      clearRenderedFallback();
      return;
    }
    if (renderedMode === context.mapMode && (roadCollection || groundRoadPrimitives.length || vehicleCollection)) return;

    clearRenderedFallback();
    renderedMode = context.mapMode;
    const photoreal = context.mapMode === "photoreal";
    const flowMap = new Map(flows.map((flow) => [flow.roadId, flow]));
    const roadMap = new Map(roads.map((road) => [road.id, road]));
    const pointHeightCache = new Map<string, number>();
    const unresolvedHeightProbe: {
      current: { longitude: number; latitude: number } | null;
    } = { current: null };
    const groundPolylineSupported = Boolean(
      photoreal &&
      Cesium.GroundPolylinePrimitive?.isSupported?.(viewer.scene) &&
      Cesium.ClassificationType?.CESIUM_3D_TILE != null,
    );

    roadCollection = (!photoreal || !groundPolylineSupported)
      ? new Cesium.PolylineCollection()
      : null;
    vehicleCollection = new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    if (roadCollection) viewer.scene.primitives.add(roadCollection);
    viewer.scene.primitives.add(vehicleCollection);

    const pointHeight = (roadId: number, longitude: number, latitude: number) => {
      if (!photoreal) return 8;
      const key = `${roadId}:${longitude.toFixed(6)}:${latitude.toFixed(6)}`;
      const cached = pointHeightCache.get(key);
      if (cached != null) return cached;
      if (viewer.scene.sampleHeightSupported && typeof viewer.scene.sampleHeight === 'function') {
        try {
          const sampled = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(longitude, latitude));
          if (Number.isFinite(sampled)) {
            const elevated = sampled + 1.5;
            pointHeightCache.set(key, elevated);
            return elevated;
          }
        } catch {}
      }
      // The 3D stack may be active before local photogrammetry has streamed in.
      // Keep this temporary ellipsoid position uncached so later scene frames
      // can replace it with a real sampled height.
      unresolvedHeightProbe.current ??= { longitude, latitude };
      return 1.5;
    };

    vehicleMotion = createTrafficMotionModel({
      Cesium,
      roads,
      vehicles,
      heightForPoint: pointHeight,
    });

    const maxVehicles = photoreal ? 100 : vehicles.length;
    const renderVehicles = () => {
      if (!vehicleCollection || destroyed) return;
      const visibleCount = Math.min(maxVehicles, vehicles.length);
      while (vehicleCollection.length < visibleCount) {
        const index = vehicleCollection.length;
        const initialPosition = vehicleMotion?.positionFor(index);
        if (!initialPosition) break;
        const vehicle = vehicles[index];
        const road = roadMap.get(vehicle?.roadId);
        const kind = vehicleKind(index, road);
        vehicleCollection.add({
          position: initialPosition,
          image: VEHICLE_ICONS[kind],
          width: kind === "truck" ? 18 : kind === "van" ? 16 : 14,
          height: kind === "truck" ? 12 : 11,
          rotation: Cesium.Math.toRadians(-(vehicle?.headingDeg ?? 0)),
          color: Cesium.Color.WHITE,
          scaleByDistance: new Cesium.NearFarScalar(100, 1.6, 120_000, 0.28),
          translucencyByDistance: new Cesium.NearFarScalar(100, 1.0, 160_000, 0.12),
          // Donor-style bounded punch-through: buildings still occlude cars.
          disableDepthTestDistance: 2_000,
        });
      }
      while (vehicleCollection.length > visibleCount) {
        vehicleCollection.remove(vehicleCollection.get(vehicleCollection.length - 1));
      }

      for (let index = 0; index < visibleCount; index += 1) {
        const vehicle = vehicles[index];
        const billboard = vehicleCollection.get(index);
        const road = roadMap.get(vehicle.roadId);
        const kind = vehicleKind(index, road);
        billboard.image = VEHICLE_ICONS[kind];
        billboard.width = (kind === "truck" ? 18 : kind === "van" ? 16 : 14) * (context.cameraHeight < 8_000 ? 1.25 : 1);
        billboard.height = (kind === "truck" ? 12 : 11) * (context.cameraHeight < 8_000 ? 1.25 : 1);
        billboard.rotation = Cesium.Math.toRadians(-(vehicle.headingDeg ?? 0));
        billboard.color = Cesium.Color.fromCssColorString(
          getCongestionColor(vehicle.congestion ?? 'free-flow'),
        ).withAlpha(photoreal ? 0.9 : 0.94);
      }
      vehicleMotion?.writePositions(vehicleCollection, visibleCount);
      viewer.scene?.requestRender?.();
    };

    if (groundPolylineSupported) {
      const groups = new Map<string, any[]>();
      for (const road of roads) {
        if (road.coordinates.length < 2) continue;
        const congestion = flowMap.get(road.id)?.congestion ?? 'free-flow';
        const list = groups.get(congestion) ?? [];
        list.push(new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
            width: road.highway === 'motorway' || road.highway === 'trunk' ? 2.2 : 1.25,
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
              color: Cesium.Color.fromCssColorString(getCongestionColor(congestion as any)).withAlpha(0.58),
              glowPower: 0.06,
            }),
          }),
        }));
        groundRoadPrimitives.push(primitive);
      }
    } else if (roadCollection) {
      for (const road of roads) {
        if (road.coordinates.length < 2) continue;
        roadCollection.add({
          positions: road.coordinates.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat, photoreal ? pointHeight(road.id, lon, lat) + 1 : 5)),
          width: road.highway === 'motorway' || road.highway === 'trunk' ? 3 : 2,
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.fromCssColorString(
              getCongestionColor(flowMap.get(road.id)?.congestion ?? 'free-flow'),
            ).withAlpha(photoreal ? 0.68 : 0.82),
          }),
        });
      }
    }

    renderVehicles();

    const unresolvedProbe = unresolvedHeightProbe.current;
    if (
      photoreal &&
      unresolvedProbe &&
      !photorealHeightRebindRemover &&
      viewer.scene.postRender?.addEventListener
    ) {
      const probe = unresolvedProbe;
      photorealHeightRebindRemover = viewer.scene.postRender.addEventListener(() => {
        if (destroyed || context.mapMode !== "photoreal" || !fallbackVisible()) {
          photorealHeightRebindRemover?.();
          photorealHeightRebindRemover = null;
          return;
        }
        const nowMs = performance.now();
        if (nowMs - lastPhotorealHeightProbeMs < 250) return;
        lastPhotorealHeightProbeMs = nowMs;

        let sampledHeight = Number.NaN;
        try {
          sampledHeight = viewer.scene.sampleHeight(
            Cesium.Cartographic.fromDegrees(probe.longitude, probe.latitude),
          );
        } catch {}
        if (!Number.isFinite(sampledHeight)) return;

        const remove = photorealHeightRebindRemover;
        photorealHeightRebindRemover = null;
        remove?.();

        // Rebuild only Traffic. The donor-owned 3D map stack stays untouched.
        clearRenderedFallback();
        renderFallback();
      });
      viewer.scene?.requestRender?.();
    }

    if (vehicles.length) {
      // Bilawal/GEV pattern: animation belongs to Cesium's frame lifecycle, not
      // an independent timer. The governor keeps frames continuous only while
      // this animator actually exists.
      holdContinuousRender('traffic');
      lastVehicleFrameMs = performance.now();
      vehiclePreRenderRemover = viewer.scene.preRender.addEventListener(() => {
        if (!vehicleCollection || destroyed || !fallbackVisible()) return;
        const nowMs = performance.now();
        const dt = Math.min(Math.max((nowMs - lastVehicleFrameMs) / 1000, 0), 0.1);
        lastVehicleFrameMs = nowMs;
        if (dt <= 0) return;
        vehicleMotion?.advance(dt);
        vehicleMotion?.writePositions(vehicleCollection, maxVehicles);
      });
    }

    publish(
      'degraded',
      photoreal
        ? `3D traffic · cached OSM roads + ${Math.min(100, vehicles.length)} modeled vehicles · scene-bound road heights`
        : 'Cached OSM road geometry + locally modeled vehicles · live TomTom unavailable',
    );
  };

  async function ensureFallback(prefetchOnly = false) {
    if (destroyed || !context.enabled || !context.earthVisible) {
      clearRenderedFallback();
      return;
    }
    if (!prefetchOnly && !fallbackSourceNeeded()) {
      clearRenderedFallback();
      return;
    }

    const nextCenter = { latitude: context.latitude, longitude: context.longitude };
    const needsRebase = !dataCenter || distanceKm(dataCenter, nextCenter) >= 3.5;

    // Zoom/tilt never reacquire roads or regenerate vehicles.
    if (!needsRebase && roads.length) {
      if (fallbackSourceNeeded()) renderFallback();
      return;
    }
    if (vectorController) return;

    const controller = new AbortController();
    vectorController = controller;
    if (!prefetchOnly || fallbackSourceNeeded()) publish('loading');
    try {
      const nextRoads = await fetchRoads(
        nextCenter.latitude,
        nextCenter.longitude,
        8,
        controller.signal,
      );
      if (controller.signal.aborted || destroyed) return;

      dataCenter = nextCenter;
      roads = nextRoads.slice(0, 500);
      flows = buildModeledFlows(roads);
      vehicles = generateModeledVehicles(roads, flows, 260);
      vehicleCount = vehicles.length;

      clearRenderedFallback();
      if (!roads.length) {
        publish('error', 'No OSM road geometry returned for this traffic coverage');
        return;
      }
      if (fallbackSourceNeeded()) {
        renderFallback();
        if (!fallbackVisible()) {
          publish('degraded', 'Traffic data cached for this area · zoom changes rendering only');
        }
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
        clearRenderedFallback();
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
      const previous = context;
      const wasActive = previous.enabled && previous.earthVisible;
      context = next;
      const active = context.enabled && context.earthVisible;

      if (!active) {
        statusController?.abort();
        statusController = null;
        unmountLive();
        clearRenderedFallback();
        liveFailed = false;
        publish('idle');
        return;
      }

      if (context.mapMode === "photoreal") {
        // TomTom is a globe imagery raster; draping it under Google 3D creates
        // competing Earth surfaces. Keep traffic in 3D through the dedicated
        // classified-road + vehicle overlay instead.
        unmountLive();
      } else {
        mountLive();
        if (status?.configured && status.available && !liveFailed) clearRenderedFallback();
      }
      if (!wasActive || (!status && !statusController)) void refreshStatus();
      // Pre-warm the same OSM road/vehicle state while SAT/MAP/NASA are active.
      // A later switch to 3D therefore changes rendering, not data acquisition.
      if (!dataCenter || !roads.length) void ensureFallback(true);

      const modeChanged = previous.mapMode !== context.mapMode;
      const movedKm = distanceKm(
        { latitude: previous.latitude, longitude: previous.longitude },
        { latitude: context.latitude, longitude: context.longitude },
      );
      const geographicMove = !wasActive || movedKm >= 3.5;

      if (fallbackSourceNeeded()) {
        if (geographicMove || !dataCenter || !roads.length) {
          void ensureFallback();
        } else if (modeChanged) {
          clearRenderedFallback();
          renderFallback();
        } else if (fallbackVisible()) {
          renderFallback();
        } else {
          clearRenderedFallback();
          publish('degraded', 'Traffic data cached for this area · zoom in to render');
        }
      } else {
        clearRenderedFallback();
      }
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
