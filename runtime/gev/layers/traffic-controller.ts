import { fetchTrafficStatus, type TrafficStatus } from '@/lib/traffic';
import {
  buildModeledFlows,
  fetchRoadsForBounds,
  getCongestionColor,
  type FlowSegment,
  type RoadSegment,
} from '@/lib/traffic-vector';
import { fetchTomTomFlowsForRoads } from '@/lib/traffic-live-flow';
import {
  generateTrafficParticles,
  particleColorCss,
  particlePixelSize,
  type TrafficParticle,
} from '@/lib/traffic-particles';
import type { LayerLoadState } from '@/lib/layer-runtime';
import { holdContinuousRender, releaseContinuousRender } from '@/runtime/gev/render-governor';
import { createTrafficMotionModel } from '@/runtime/gev/layers/traffic-motion';

type Context = {
  enabled: boolean;
  earthVisible: boolean;
  latitude: number;
  longitude: number;
  cameraHeight: number;
  mapMode: 'photoreal' | 'satellite' | 'map' | 'nasa';
};

type RuntimeState = {
  state: LayerLoadState;
  status: TrafficStatus | null;
  error?: string;
  vehicleCount: number;
};

function boundsAround(latitude: number, longitude: number, radiusKm: number) {
  const latDeg = radiusKm / 111;
  const lonDeg = radiusKm / Math.max(20, 111 * Math.cos(latitude * Math.PI / 180));
  return {
    south: latitude - latDeg,
    west: longitude - lonDeg,
    north: latitude + latDeg,
    east: longitude + lonDeg,
  };
}

/**
 * Traffic ownership remains bounded:
 * - live TomTom raster stays exactly on the current globe / 3D tileset path;
 * - OSM road acquisition stays on /api/roads;
 * - donor-derived PointPrimitive traffic replaces SVG billboards only;
 * - TomTom vector flow may refine particle speed/density, but any vector
 *   failure degrades particles to the donor's keyless simulation and never
 *   removes the already-working raster traffic.
 */
export function createTrafficController(input: {
  viewer: any;
  Cesium: any;
  getPhotorealisticTileset?: () => any | null;
  onState: (value: RuntimeState) => void;
}) {
  const { viewer, Cesium, getPhotorealisticTileset = () => null, onState } = input;

  let context: Context = {
    enabled: false,
    earthVisible: true,
    latitude: 0,
    longitude: 0,
    cameraHeight: Number.POSITIVE_INFINITY,
    mapMode: 'satellite',
  };
  let status: TrafficStatus | null = null;
  let flowLayer: any = null;
  let incidentLayer: any = null;
  let flowProvider: any = null;
  let incidentProvider: any = null;
  let liveLayerCollection: any = null;
  let statusController: AbortController | null = null;
  let vectorController: AbortController | null = null;
  let liveFlowController: AbortController | null = null;
  let roadCollection: any = null;
  let groundRoadPrimitives: any[] = [];
  let particleCollection: any = null;
  let particleMotion: ReturnType<typeof createTrafficMotionModel> | null = null;
  let particlePreRenderRemover: (() => void) | null = null;
  let lastParticleFrameMs = 0;

  let dataCenter: { latitude: number; longitude: number } | null = null;
  let roads: RoadSegment[] = [];
  let flows: FlowSegment[] = [];
  let particles: TrafficParticle[] = [];
  let renderedMode: Context['mapMode'] | null = null;
  let liveFailed = false;
  let destroyed = false;
  let vehicleCount = 0;
  let flowCoveragePct = 0;
  let dataGeneration = 0;
  let roadDetail: "none" | "major" | "full" = "none";
  let particleDensityBand = -1;

  const publish = (state: LayerLoadState, error?: string) => {
    onState({ state, status, error, vehicleCount });
  };

  const clearRenderedFallback = () => {
    particlePreRenderRemover?.();
    particlePreRenderRemover = null;
    lastParticleFrameMs = 0;
    releaseContinuousRender('traffic');
    if (particleCollection) {
      try { viewer.scene.primitives.remove(particleCollection); } catch {}
    }
    if (roadCollection) {
      try { viewer.scene.primitives.remove(roadCollection); } catch {}
    }
    for (const primitive of groundRoadPrimitives) {
      try { viewer.scene.groundPrimitives.remove(primitive); } catch {}
    }
    groundRoadPrimitives = [];
    particleCollection = null;
    particleMotion = null;
    roadCollection = null;
    renderedMode = null;
    viewer.scene?.requestRender?.();
  };

  const clearVector = () => {
    vectorController?.abort();
    vectorController = null;
    liveFlowController?.abort();
    liveFlowController = null;
    dataGeneration += 1;
    clearRenderedFallback();
    dataCenter = null;
    roads = [];
    flows = [];
    particles = [];
    vehicleCount = 0;
    flowCoveragePct = 0;
    roadDetail = "none";
    particleDensityBand = -1;
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

  const densityBandFor = (height: number) =>
    height < 1_000 ? 0 :
    height < 3_000 ? 1 :
    height < 5_000 ? 2 : 3;

  const trafficFetchBounds = () => {
    const maxSpan = 0.05;
    let latSpan = maxSpan;
    let lonSpan = maxSpan;

    try {
      const rect = viewer.camera.computeViewRectangle?.();
      if (rect) {
        const south = Cesium.Math.toDegrees(rect.south);
        const west = Cesium.Math.toDegrees(rect.west);
        const north = Cesium.Math.toDegrees(rect.north);
        const east = Cesium.Math.toDegrees(rect.east);
        if ([south, west, north, east].every(Number.isFinite)) {
          latSpan = Math.min(maxSpan, Math.max(0.005, north - south));
          lonSpan = Math.min(maxSpan, Math.max(0.005, east - west));
        }
      }
    } catch {}

    let latitude = context.latitude;
    let longitude = context.longitude;
    try {
      const canvas = viewer.scene.canvas;
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (width > 0 && height > 0) {
        const hit = viewer.camera.pickEllipsoid(
          new Cesium.Cartesian2(width / 2, height / 2),
          Cesium.Ellipsoid.WGS84,
        );
        if (hit) {
          const cartographic = Cesium.Cartographic.fromCartesian(hit);
          const hitLat = Cesium.Math.toDegrees(cartographic.latitude);
          const hitLon = Cesium.Math.toDegrees(cartographic.longitude);
          if (Number.isFinite(hitLat) && Number.isFinite(hitLon)) {
            latitude = hitLat;
            longitude = hitLon;
          }
        }
      }
    } catch {}

    return {
      center: { latitude, longitude },
      bounds: {
        south: latitude - latSpan / 2,
        west: longitude - lonSpan / 2,
        north: latitude + latSpan / 2,
        east: longitude + lonSpan / 2,
      },
    };
  };

  const rebuildParticles = () => {
    particles = generateTrafficParticles(roads, flows, context.cameraHeight, 1200);
    vehicleCount = particles.length;
    particleDensityBand = densityBandFor(context.cameraHeight);
  };

  const onTileError = (error: any) => {
    if (destroyed || !context.enabled || !context.earthVisible) return;
    liveFailed = true;
    const http = Number(error?.statusCode ?? 0);
    publish(
      'degraded',
      http
        ? 'Traffic tile request failed (HTTP ' + http + ') · OSM particles remain'
        : 'Traffic tile refresh delayed · OSM particles remain',
    );
    void ensureFallback();
  };

  const liveImageryCollection = () => {
    if (context.mapMode !== 'photoreal') return viewer.imageryLayers;
    const tileset = getPhotorealisticTileset();
    const collection = tileset?.imageryLayers;
    return collection?.addImageryProvider && collection?.remove ? collection : null;
  };

  const unmountLive = () => {
    flowProvider?.errorEvent?.removeEventListener(onTileError);
    incidentProvider?.errorEvent?.removeEventListener(onTileError);
    const collection = liveLayerCollection;
    if (flowLayer) {
      try { collection?.remove(flowLayer, true); } catch {}
    }
    if (incidentLayer) {
      try { collection?.remove(incidentLayer, true); } catch {}
    }
    flowProvider = null;
    incidentProvider = null;
    flowLayer = null;
    incidentLayer = null;
    liveLayerCollection = null;
  };

  const mountLive = () => {
    if (destroyed || !context.enabled || !context.earthVisible) return false;
    const collection = liveImageryCollection();
    if (!collection) return false;
    if (flowLayer && liveLayerCollection === collection) return true;
    if (flowLayer || incidentLayer || liveLayerCollection) unmountLive();

    flowProvider = new Cesium.UrlTemplateImageryProvider({
      url: '/api/traffic?z={z}&x={x}&y={y}',
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: 'Traffic © TomTom',
    });
    flowProvider.errorEvent?.addEventListener(onTileError);
    flowLayer = collection.addImageryProvider(flowProvider);
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
    incidentLayer = collection.addImageryProvider(incidentProvider);
    incidentLayer.alpha = 0.7;
    liveLayerCollection = collection;
    viewer.scene?.requestRender?.();
    return true;
  };

  const fallbackSourceNeeded = () =>
    context.mapMode === 'photoreal' ||
    liveFailed ||
    (status != null && (!status.configured || !status.available));

  const fallbackVisible = () =>
    context.enabled &&
    context.earthVisible &&
    context.cameraHeight < (context.mapMode === 'photoreal' ? 600_000 : 180_000) &&
    fallbackSourceNeeded();

  const renderFallback = () => {
    if (destroyed || !fallbackVisible() || !roads.length) {
      clearRenderedFallback();
      return;
    }
    if (renderedMode === context.mapMode && particleCollection) return;

    clearRenderedFallback();
    renderedMode = context.mapMode;
    const photoreal = context.mapMode === 'photoreal';
    const flowMap = new Map(flows.map((flow) => [flow.roadId, flow]));
    const roadMap = new Map(roads.map((road) => [road.id, road]));
    const roadBaseHeights = new Map<number, number>();
    const liveTomTomDrape = photoreal && Boolean(flowLayer && liveLayerCollection);
    const groundPolylineSupported = Boolean(
      photoreal &&
      !liveTomTomDrape &&
      Cesium.GroundPolylinePrimitive?.isSupported?.(viewer.scene) &&
      Cesium.ClassificationType?.CESIUM_3D_TILE != null
    );

    roadCollection = (!photoreal || (!groundPolylineSupported && !liveTomTomDrape))
      ? new Cesium.PolylineCollection()
      : null;
    particleCollection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    if (roadCollection) viewer.scene.primitives.add(roadCollection);
    viewer.scene.primitives.add(particleCollection);

    const roadHeight = (roadId: number) => {
      if (!photoreal) return 8;
      const cached = roadBaseHeights.get(roadId);
      if (cached != null) return cached;
      let height = 0;
      const first = roadMap.get(roadId)?.coordinates?.[0];
      if (first && viewer.scene.sampleHeightSupported && typeof viewer.scene.sampleHeight === 'function') {
        try {
          const sampled = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(first[0], first[1]));
          if (Number.isFinite(sampled)) height = sampled;
        } catch {}
      }
      roadBaseHeights.set(roadId, height);
      return height;
    };

    particleMotion = createTrafficMotionModel({
      Cesium,
      roads,
      particles,
      heightForRoad: (roadId) => photoreal ? roadHeight(roadId) + 3 : 8,
    });

    const maxParticles = photoreal ? Math.min(900, particles.length) : particles.length;
    for (let index = 0; index < maxParticles; index += 1) {
      const particle = particles[index];
      const position = particleMotion.positionFor(index);
      if (!position) continue;
      particleCollection.add({
        position,
        pixelSize: particlePixelSize(particle) * (context.cameraHeight < 8_000 ? 1.15 : 1),
        color: Cesium.Color.fromCssColorString(particleColorCss(particle)).withAlpha(particle.bucket ? 0.92 : 0.85),
        scaleByDistance: new Cesium.NearFarScalar(100, 1.5, 120_000, particle.bucket === 'jam' ? 0.55 : 0.3),
        translucencyByDistance: new Cesium.NearFarScalar(100, 1.0, 160_000, 0.08),
        // Preserve the owner-observed visible 3D baseline while switching the
        // primitive type. We can tighten occlusion only after UAT proves height.
        disableDepthTestDistance: photoreal ? Number.POSITIVE_INFINITY : 2_000,
      });
    }

    if (!liveTomTomDrape && groundPolylineSupported) {
      const groups = new Map<string, any[]>();
      for (const road of roads) {
        if (road.coordinates.length < 2) continue;
        const flow = flowMap.get(road.id);
        const key = flow?.source === 'tomtom-live' ? flow.congestion : 'simulated';
        const list = groups.get(key) ?? [];
        list.push(new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
            width: road.highway === 'motorway' || road.highway === 'trunk' ? 2.2 : 1.25,
          }),
        }));
        groups.set(key, list);
      }
      for (const [key, instances] of groups) {
        if (!instances.length) continue;
        const color = key === 'simulated' ? '#94a3b8' : getCongestionColor(key as FlowSegment['congestion']);
        const primitive = viewer.scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineGlow', {
              color: Cesium.Color.fromCssColorString(color).withAlpha(key === 'simulated' ? 0.22 : 0.58),
              glowPower: 0.06,
            }),
          }),
        }));
        groundRoadPrimitives.push(primitive);
      }
    } else if (!liveTomTomDrape && roadCollection) {
      for (const road of roads) {
        if (road.coordinates.length < 2) continue;
        const flow = flowMap.get(road.id);
        const color = flow?.source === 'tomtom-live'
          ? getCongestionColor(flow.congestion)
          : '#94a3b8';
        const fallbackHeight = photoreal ? roadHeight(road.id) + 4 : 5;
        roadCollection.add({
          positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, fallbackHeight)),
          width: road.highway === 'motorway' || road.highway === 'trunk' ? 3 : 2,
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.fromCssColorString(color).withAlpha(flow?.source === 'tomtom-live' ? 0.72 : 0.28),
          }),
        });
      }
    }

    if (maxParticles > 0) {
      holdContinuousRender('traffic');
      lastParticleFrameMs = performance.now();
      particlePreRenderRemover = viewer.scene.preRender.addEventListener(() => {
        if (!particleCollection || destroyed || !fallbackVisible()) return;
        const nowMs = performance.now();
        const dt = Math.min(Math.max((nowMs - lastParticleFrameMs) / 1000, 0), 0.1);
        lastParticleFrameMs = nowMs;
        if (dt <= 0) return;
        particleMotion?.advance(dt);
        particleMotion?.writePositions(particleCollection, maxParticles);
      });
    }

    if (liveTomTomDrape) {
      publish('ready');
    } else {
      publish(
        'degraded',
        photoreal
          ? '3D traffic · OSM particle simulation · TomTom raster drape unavailable'
          : 'OSM particle simulation · live TomTom unavailable',
      );
    }
  };

  const refreshLiveParticleFlow = async () => {
    if (
      destroyed ||
      context.mapMode !== 'photoreal' ||
      !status?.configured ||
      !status.available ||
      !dataCenter ||
      !roads.length
    ) return;

    liveFlowController?.abort();
    const controller = new AbortController();
    liveFlowController = controller;
    const generation = dataGeneration;
    try {
      const result = await fetchTomTomFlowsForRoads(
        roads,
        boundsAround(dataCenter.latitude, dataCenter.longitude, 8),
        controller.signal,
      );
      if (controller.signal.aborted || destroyed || generation !== dataGeneration) return;
      if (!result.matchedCount) return;

      flows = result.flows;
      flowCoveragePct = result.coveragePct;
      rebuildParticles();
      clearRenderedFallback();
      if (fallbackVisible()) renderFallback();
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      // Vector flow is optional refinement. Never mark the already-working
      // TomTom raster as failed when this legacy/optional endpoint is rejected.
      flowCoveragePct = 0;
    } finally {
      if (liveFlowController === controller) liveFlowController = null;
    }
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

    const target = trafficFetchBounds();
    const nextCenter = target.center;
    const needsRebase = !dataCenter || distanceKm(dataCenter, nextCenter) >= 0.35;
    const wantsFull = context.cameraHeight < 4_500;

    if (!needsRebase && roads.length && (!wantsFull || roadDetail === "full")) {
      const nextBand = densityBandFor(context.cameraHeight);
      if (nextBand !== particleDensityBand) {
        rebuildParticles();
        clearRenderedFallback();
      }
      if (fallbackSourceNeeded()) renderFallback();
      if (context.mapMode === "photoreal") void refreshLiveParticleFlow();
      return;
    }
    if (vectorController) return;

    const request = new AbortController();
    vectorController = request;
    const generation = ++dataGeneration;
    if (!prefetchOnly || fallbackSourceNeeded()) publish("loading");

    let majorRoads: RoadSegment[] = [];
    try {
      majorRoads = await fetchRoadsForBounds(target.bounds, true, request.signal);
      if (request.signal.aborted || destroyed || generation !== dataGeneration) return;

      dataCenter = nextCenter;
      roads = majorRoads.slice(0, 500);
      roadDetail = "major";
      flows = buildModeledFlows(roads);
      flowCoveragePct = 0;
      rebuildParticles();

      clearRenderedFallback();
      if (roads.length && fallbackSourceNeeded()) renderFallback();

      if (wantsFull) {
        try {
          const fullRoads = await fetchRoadsForBounds(target.bounds, false, request.signal);
          if (request.signal.aborted || destroyed || generation !== dataGeneration) return;
          if (fullRoads.length) {
            roads = fullRoads.slice(0, 500);
            roadDetail = "full";
            flows = buildModeledFlows(roads);
            flowCoveragePct = 0;
            rebuildParticles();
            clearRenderedFallback();
            if (fallbackSourceNeeded()) renderFallback();
          }
        } catch (detailError) {
          if (request.signal.aborted || destroyed || generation !== dataGeneration) return;
          if (!majorRoads.length) throw detailError;
        }
      }

      if (!roads.length) {
        publish("error", "No OSM road geometry returned for this traffic coverage");
        return;
      }
      if (fallbackSourceNeeded() && !fallbackVisible()) {
        publish("degraded", "Traffic data cached for this area · zoom in to render");
      }
      if (context.mapMode === "photoreal") void refreshLiveParticleFlow();
    } catch (error) {
      if (request.signal.aborted || destroyed || generation !== dataGeneration) return;
      if (majorRoads.length) return;
      publish("error", error instanceof Error ? error.message : "OSM road geometry unavailable");
    } finally {
      if (vectorController === request) vectorController = null;
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
      if (next.configured && next.available && !liveFailed) {
        const mounted = mountLive();
        if (context.mapMode === 'photoreal') {
          if (!mounted) publish('degraded', 'TomTom live flow is available but Cesium 3D imagery drape is unavailable · OSM particles remain');
          void ensureFallback();
          void refreshLiveParticleFlow();
        } else {
          clearRenderedFallback();
          publish('ready');
        }
      } else {
        publish(
          'degraded',
          context.mapMode === 'photoreal'
            ? '3D traffic uses OSM particles · TomTom live flow unavailable'
            : 'Live TomTom flow unavailable · OSM particle traffic available near ground',
        );
        void ensureFallback();
      }
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      status = null;
      publish(
        'degraded',
        error instanceof Error
          ? error.message + ' · OSM particle traffic remains'
          : 'Live traffic status unavailable · OSM particle traffic remains',
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

      const liveMounted = mountLive();
      if (
        context.mapMode !== 'photoreal' &&
        liveMounted &&
        status?.configured &&
        status.available &&
        !liveFailed
      ) {
        clearRenderedFallback();
      }
      if (!wasActive || (!status && !statusController)) void refreshStatus();
      if (!dataCenter || !roads.length) void ensureFallback(true);

      const modeChanged = previous.mapMode !== context.mapMode;
      const movedKm = distanceKm(
        { latitude: previous.latitude, longitude: previous.longitude },
        { latitude: context.latitude, longitude: context.longitude },
      );
      const geographicMove = !wasActive || movedKm >= 0.35;
      const densityBandChanged = densityBandFor(context.cameraHeight) !== particleDensityBand;

      if (fallbackSourceNeeded()) {
        if (geographicMove || !dataCenter || !roads.length) {
          void ensureFallback();
        } else if (modeChanged || densityBandChanged || (context.cameraHeight < 4_500 && roadDetail !== "full")) {
          void ensureFallback();
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
