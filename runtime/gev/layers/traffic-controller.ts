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
import { createRoadSurfaceResolver } from '@/runtime/gev/services/road-surface';

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
 * - live TomTom raster stays on globe imagery modes when entitled; all modes
 *   can fall back to road-matched TomTom vector flow;
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
  const surface = createRoadSurfaceResolver({ viewer, Cesium });

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
  // Donor lifecycle invariant: keep one PointPrimitiveCollection in the
  // Cesium scene graph and only clear/show it between traffic refreshes.
  // Re-adding the collection during Google 3D refinement causes avoidable
  // scene-graph churn.
  let particleCollection: any = new Cesium.PointPrimitiveCollection({
    blendOption: Cesium.BlendOption.TRANSLUCENT,
  });
  particleCollection.show = false;
  viewer.scene.primitives.add(particleCollection);
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
  let near3dDrapeReady = false;
  let near3dDrapeGeneration = 0;
  let near3dDrapeTimer: ReturnType<typeof setTimeout> | null = null;
  let near3dTileProgressRemover: (() => void) | null = null;

  const publish = (state: LayerLoadState, error?: string) => {
    onState({ state, status, error, vehicleCount });
  };

  const clearRenderedFallback = () => {
    particlePreRenderRemover?.();
    particlePreRenderRemover = null;
    lastParticleFrameMs = 0;
    releaseContinuousRender('traffic');
    if (particleCollection) {
      try { particleCollection.removeAll(); } catch {}
      particleCollection.show = false;
    }
    if (roadCollection) {
      try { viewer.scene.primitives.remove(roadCollection); } catch {}
    }
    particleMotion = null;
    roadCollection = null;
    renderedMode = null;
    viewer.scene?.requestRender?.();
  };

  const clearNear3dDrapeWait = () => {
    near3dDrapeGeneration += 1;
    near3dDrapeReady = false;
    if (near3dDrapeTimer) {
      clearTimeout(near3dDrapeTimer);
      near3dDrapeTimer = null;
    }
    near3dTileProgressRemover?.();
    near3dTileProgressRemover = null;
  };

  const armNear3dDrape = () => {
    clearNear3dDrapeWait();
    surface.reset();
    if (
      destroyed ||
      context.mapMode !== "photoreal" ||
      context.cameraHeight >= 8_000
    ) return;

    const tileset = getPhotorealisticTileset();
    if (!tileset) return;
    const generation = near3dDrapeGeneration;
    const settle = () => {
      if (near3dDrapeTimer) clearTimeout(near3dDrapeTimer);
      near3dDrapeTimer = setTimeout(() => {
        near3dDrapeTimer = null;
        if (
          destroyed ||
          generation !== near3dDrapeGeneration ||
          context.mapMode !== "photoreal" ||
          context.cameraHeight >= 8_000
        ) return;
        near3dDrapeReady = true;
        near3dTileProgressRemover?.();
        near3dTileProgressRemover = null;

        // Keep an already-mounted TomTom drape stable while Google 3D refines.
        // Re-adding imagery providers and rebuilding particle primitives at each
        // settle point created avoidable scene-graph churn and competed with 3D tiles.
        mountLive();

        if (
          roads.length &&
          fallbackVisible() &&
          (!particleCollection?.show || renderedMode !== context.mapMode)
        ) {
          renderFallback();
        }
        viewer.scene?.requestRender?.();
      }, 650);
    };

    const progressEvent = tileset.tileLoadProgressEvent;
    if (progressEvent?.addEventListener) {
      const onProgress = (pending: number) => {
        if (generation !== near3dDrapeGeneration) return;
        if (Number(pending) <= 0) {
          settle();
        } else if (near3dDrapeTimer) {
          clearTimeout(near3dDrapeTimer);
          near3dDrapeTimer = null;
        }
      };
      near3dTileProgressRemover = progressEvent.addEventListener(onProgress);
      if (tileset.tilesLoaded === true) settle();
    } else {
      // Compatibility fallback only when this Cesium tileset route does not
      // expose tileLoadProgressEvent. Do not delay the whole layer indefinitely.
      near3dDrapeTimer = setTimeout(settle, 1800);
    }
  };

  const clearVector = () => {
    vectorController?.abort();
    vectorController = null;
    liveFlowController?.abort();
    liveFlowController = null;
    dataGeneration += 1;
    clearRenderedFallback();
    dataCenter = null;
    surface.reset();
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

  const isSubsurfaceRoad = surface.isSubsurfaceRoad;
  // Tunnel roads stay in the motion graph so vehicles can disappear at one
  // portal and reappear at the next. Rendering policy, not graph deletion,
  // suppresses underground points and lines in Google 3D.
  const renderableRoads = () => roads;

  const rebuildParticles = () => {
    particles = generateTrafficParticles(renderableRoads(), flows, context.cameraHeight, 1200);
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
    // Cesium3DTileset does not own a supported ImageryLayerCollection. Raster
    // remains on SAT/MAP/NASA globe modes. Google 3D uses explicit,
    // depth-tested road geometry and never classifies the photogrammetry mesh.
    if (context.mapMode === 'photoreal') return null;
    return viewer.imageryLayers;
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
    if (!status) return false;
    if (status?.rasterAvailable === false) {
      if (flowLayer || incidentLayer || liveLayerCollection) unmountLive();
      return false;
    }
    const collection = liveImageryCollection();
    if (!collection) {
      if (flowLayer || incidentLayer || liveLayerCollection) unmountLive();
      return false;
    }
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
    (status != null && (!status.configured || status.rasterAvailable === false || !status.available));

  const fallbackVisible = () =>
    context.enabled &&
    context.earthVisible &&
    context.cameraHeight < 8_000 &&
    fallbackSourceNeeded();

  const renderFallback = () => {
    if (destroyed || !fallbackVisible() || !roads.length) {
      clearRenderedFallback();
      return;
    }
    if (
      renderedMode === context.mapMode &&
      particleCollection?.show &&
      Number(particleCollection.length ?? 0) > 0
    ) return;

    clearRenderedFallback();
    renderedMode = context.mapMode;
    const photoreal = context.mapMode === 'photoreal';
    const visibleRoads = roads;
    if (photoreal && context.cameraHeight < 8_000 && !near3dDrapeReady) {
      publish('loading', '3D traffic · waiting for stable road-surface samples');
      return;
    }
    const flowMap = new Map<number, FlowSegment>();
    for (const flow of flows) {
      const current = flowMap.get(flow.roadId);
      if (!current || (flow.level ?? 1) < (current.level ?? 1)) flowMap.set(flow.roadId, flow);
    }
    const roadMap = new Map(visibleRoads.map((road) => [road.id, road]));
    const surfaceProfiles = photoreal
      ? new Map(visibleRoads.map((road) => [road.id, surface.profileForRoad(road, road.coordinates)]))
      : new Map();
    const liveTomTomDrape = photoreal && Boolean(flowLayer && liveLayerCollection);
    const nearPhotoreal = photoreal && context.cameraHeight < 8_000;
    roadCollection = (!photoreal || !liveTomTomDrape)
      ? new Cesium.PolylineCollection()
      : null;
    if (roadCollection) viewer.scene.primitives.add(roadCollection);
    particleCollection.show = true;

    particleMotion = createTrafficMotionModel({
      Cesium,
      roads: visibleRoads,
      flows,
      particles,
      pixelScale: context.cameraHeight < 8_000 ? 1.15 : 1,
      heightForRoad: (roadId) => {
        if (!photoreal) return 8;
        const profile = surfaceProfiles.get(roadId);
        return profile?.reliable ? (profile.heights[0] ?? 0) + 2.2 : 0;
      },
      visibleForRoad: (roadId) => {
        if (!photoreal) return true;
        const road = roadMap.get(roadId);
        return Boolean(road && !isSubsurfaceRoad(road) && surfaceProfiles.get(roadId)?.reliable);
      },
      heightForCoordinate: (roadId, _coordinate, index, count) => {
        if (!photoreal) return null;
        const profile = surfaceProfiles.get(roadId);
        if (!profile?.reliable || !profile.heights.length) return null;
        const profileIndex = count > 1
          ? Math.round(index / (count - 1) * (profile.heights.length - 1))
          : 0;
        return (profile.heights[profileIndex] ?? profile.heights[0]) + 2.2;
      },
    });

    const maxParticles = photoreal ? Math.min(900, particles.length) : particles.length;
    for (let index = 0; index < maxParticles; index += 1) {
      const particle = particles[index];
      const position = particleMotion.positionFor(index);
      if (!position) continue;
      particleCollection.add({
        position,
        show: particleMotion.isVisible(index),
        pixelSize: particlePixelSize(particle) * (context.cameraHeight < 8_000 ? 1.15 : 1),
        color: Cesium.Color.fromCssColorString(particleColorCss(particle)).withAlpha(particle.bucket ? 0.92 : 0.85),
        scaleByDistance: new Cesium.NearFarScalar(100, 1.5, 120_000, particle.bucket === 'jam' ? 0.55 : 0.3),
        translucencyByDistance: new Cesium.NearFarScalar(100, 1.0, 160_000, 0.08),
        // In photoreal 3D, buildings and bridge structures must occlude traffic.
        // Cesium 0 means depth testing is always applied; Infinity made particles
        // visible through towers and high-rises. Non-photoreal keeps the prior
        // near-ground tolerance.
        disableDepthTestDistance: photoreal ? 0 : 2_000,
      });
    }

    if (!liveTomTomDrape && roadCollection) {
      for (const road of visibleRoads) {
        if (road.coordinates.length < 2) continue;
        if (photoreal && isSubsurfaceRoad(road)) continue;
        const flow = flowMap.get(road.id);
        if (photoreal && flow?.source !== "tomtom-live") continue;
        const profile = surfaceProfiles.get(road.id);
        if (photoreal && !profile?.reliable) continue;
        const color = flow?.source === "tomtom-live"
          ? getCongestionColor(flow.congestion)
          : "#94a3b8";
        roadCollection.add({
          positions: road.coordinates.map(([lon, lat], index) => Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            photoreal ? (profile?.heights[index] ?? 0) + 2.8 : 5,
          )),
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

    if (nearPhotoreal && !near3dDrapeReady) {
      publish(
        "loading",
        "3D traffic · Google 3D refining · TomTom road overlay deferred",
      );
    } else if (liveTomTomDrape || (photoreal && flowCoveragePct > 0)) {
      publish("ready");
    } else {
      publish(
        "degraded",
        photoreal
          ? "3D traffic · OSM particles · waiting for TomTom vector flow"
          : "OSM particle simulation · live TomTom unavailable",
      );
    }
  };

  const refreshLiveParticleFlow = async () => {
    if (
      destroyed ||
      !status?.configured ||
      !(status.vectorAvailable ?? status.available) ||
      !dataCenter ||
      !roads.length
    ) return;

    liveFlowController?.abort();
    const controller = new AbortController();
    liveFlowController = controller;
    const generation = dataGeneration;
    try {
      const flowRoads = renderableRoads();
      if (!flowRoads.length) return;
      const result = await fetchTomTomFlowsForRoads(
        flowRoads,
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
    } catch {
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
    // Match ws-donor: do not fetch or animate road particles above 8 km.
    // The TomTom overview raster may remain visible independently.
    if (context.cameraHeight >= 8_000) {
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
      void refreshLiveParticleFlow();
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
      void refreshLiveParticleFlow();
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
      const rasterAvailable = next.rasterAvailable ?? next.available;
      const vectorAvailable = next.vectorAvailable ?? next.available;
      if (next.configured && (rasterAvailable || vectorAvailable)) {
        const mounted = mountLive();
        if (mounted && context.mapMode !== 'photoreal') {
          clearRenderedFallback();
          publish('ready');
        } else if (vectorAvailable) {
          if (context.cameraHeight >= 8_000) {
            publish('degraded', 'TomTom vector flow available · zoom below 8 km for road-native traffic');
          } else if (context.mapMode === 'photoreal') {
            publish('loading', 'Google 3D refining · depth-tested traffic will appear after tiles settle');
          } else {
            publish('loading', 'Raster entitlement unavailable · loading TomTom vector traffic');
          }
          void ensureFallback();
          void refreshLiveParticleFlow();
        } else {
          publish('degraded', 'TomTom vector flow unavailable · OSM particle traffic remains');
          void ensureFallback();
        }
      } else {
        publish(
          'degraded',
          context.mapMode === 'photoreal'
            ? '3D traffic uses OSM particles · TomTom vector flow unavailable'
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
      if (context.cameraHeight < 8_000 && (!dataCenter || !roads.length)) {
        void ensureFallback(true);
      }

      const modeChanged = previous.mapMode !== context.mapMode;
      const movedKm = distanceKm(
        { latitude: previous.latitude, longitude: previous.longitude },
        { latitude: context.latitude, longitude: context.longitude },
      );
      const geographicMove = !wasActive || movedKm >= 0.35;
      const densityBandChanged = densityBandFor(context.cameraHeight) !== particleDensityBand;
      const nearPhotoreal = context.mapMode === "photoreal" && context.cameraHeight < 8_000;
      const wasNearPhotoreal = previous.mapMode === "photoreal" && previous.cameraHeight < 8_000;

      if (
        nearPhotoreal &&
        (!wasNearPhotoreal || geographicMove || modeChanged)
      ) {
        armNear3dDrape();
      } else if (!nearPhotoreal && wasNearPhotoreal) {
        clearNear3dDrapeWait();
      }

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
      clearNear3dDrapeWait();
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
      clearNear3dDrapeWait();
      clearVector();
      if (particleCollection) {
        try { viewer.scene.primitives.remove(particleCollection); } catch {}
        particleCollection = null;
      }
    },
  });
}
