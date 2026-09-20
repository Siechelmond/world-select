"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { createCoreLiveWorld } from "@/runtime/gev/core-live-world";
import { createEarthquakeRenderer } from "@/runtime/gev/layers/earthquakes-renderer";
import { createSatelliteRenderer } from "@/runtime/gev/layers/satellites-renderer";
import { createAircraftRenderer } from "@/runtime/gev/layers/aircraft-renderer";
import { createTrafficController } from "@/runtime/gev/layers/traffic-controller";
import { createPointLayerRenderer } from "@/runtime/gev/layers/point-layer-renderer";
import { createInfrastructureRenderer } from "@/runtime/gev/layers/infrastructure-renderer";
import { createCelestialBridgeRenderer } from "@/runtime/gev/layers/celestial-bridge-renderer";
import { propagateTles, type SatelliteCatalog, type SatelliteFeedMeta, type TleRecord } from "@/lib/celestrak";
import { SATELLITE_FILTERS, tallySatelliteClasses, type SatelliteFilter } from "@/lib/satellite-style";
import type { AircraftFeedMeta } from "@/lib/aircraft";
import type { MilitaryFeedMeta } from "@/lib/military";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { findGoogleStreetCoverage, loadGoogleStreetView, onGoogleMapsAuthFailure } from "@/lib/google-street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import { fetchRecentLaunches, type SpaceLaunch } from "@/lib/launches";
import SpaceExplorer from "@/components/SpaceExplorer";
import { createWorldViewer, type WorldMapMode } from "@/lib/cesium-viewer";
import { GEO_LABELS_DE } from "@/lib/geo-labels";
import { resolveLayerState, type LayerLoadState as LoadState } from "@/lib/layer-runtime";
import {
  fetchNaturalEvents,
  fetchAurora,
  fetchWeather,
  fetchRadioStations,
  searchPlaces,
  type PlaceSearchResult,
  type InfrastructureFeature,
  type InfrastructureCategory,
} from "@/lib/keyless";
import { loadInfrastructureBaseline } from "@/lib/infrastructure-local";

declare global { interface Window { Cesium?: any; google?: any; __worldSelectGoogleMapsPromise?: Promise<any>; __worldSelectGoogleMapsReady?: () => void; gm_authFailure?: () => void } }

type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type StreetProvider = "google" | "kartaview";
type EarthPoint = { latitude: number; longitude: number };
type LayerError = {
  earthquakes?: string; satellites?: string; aircraft?: string; military?: string;
  street?: string; traffic?: string; events?: string; aurora?: string;
  weather?: string; radio?: string; infrastructure?: string;
};

const DAY_MS = 86_400_000;
const LIVE_MOTION_TICK_MS = 1_000;
const MOBILE_LIVE_MOTION_TICK_MS = 2_000;
const UI_CLOCK_TICK_MS = 10_000;
const AIRCRAFT_REFRESH_MS = 15_000;
const GROUND_HEIGHT_M = 120_000;
const CELESTIAL_CONTEXT_HEIGHT_M = 6_500_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };
const EVENT_FILTERS = ["all", "fire", "storm", "volcano", "flood", "ice", "other"] as const;
const RADIO_FILTERS = ["all", "news", "talk", "weather", "public-safety", "aviation-marine", "traffic-transit", "music", "other"] as const;
const INFRA_FILTERS: InfrastructureCategory[] = ["cable", "landing", "datacenter", "dam"];

function radioMatches(item: SpatialEntity, filter: string) {
  if (filter === "all") return true;
  const tags = String(item.properties.tags ?? "").toLowerCase();
  if (filter === "news") return tags.includes("news");
  if (filter === "talk") return tags.includes("talk");
  if (filter === "weather") return tags.includes("weather") || tags.includes("emergency");
  if (filter === "public-safety") return tags.includes("scanner") || tags.includes("public safety") || tags.includes("police") || tags.includes("fire");
  if (filter === "aviation-marine") return tags.includes("aviation") || tags.includes("marine");
  if (filter === "traffic-transit") return tags.includes("traffic") || tags.includes("transit");
  if (filter === "music") return /(music|rock|pop|jazz|classical|dance|electronic|country|hip hop|metal)/.test(tags);
  return !/(news|talk|weather|emergency|scanner|public safety|police|aviation|marine|traffic|transit|music|rock|pop|jazz|classical|dance|electronic|country|hip hop|metal)/.test(tags);
}

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
const CESIUM_ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";
const SEN_ISS_LIVE_VIDEO_ID = process.env.NEXT_PUBLIC_SEN_ISS_LIVE_VIDEO_ID ?? "fO9e9jnhYK8";
export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<any>(null);
  const entityMapRef = useRef(new Map<string, SpatialEntity>());
  const earthquakeRendererRef = useRef<ReturnType<typeof createEarthquakeRenderer> | null>(null);
  const satelliteRendererRef = useRef<ReturnType<typeof createSatelliteRenderer> | null>(null);
  const aircraftRendererRef = useRef<ReturnType<typeof createAircraftRenderer> | null>(null);
  const geoLabelIdsRef = useRef(new Set<string>());
  const annotationIdsRef = useRef(new Set<string>());
  const viewerLifecycleRef = useRef<ReturnType<typeof createWorldViewer> | null>(null);
  const trafficControllerRef = useRef<ReturnType<typeof createTrafficController> | null>(null);
  const celestialBridgeRendererRef = useRef<ReturnType<typeof createCelestialBridgeRenderer> | null>(null);
  const eventRendererRef = useRef<ReturnType<typeof createPointLayerRenderer> | null>(null);
  const auroraRendererRef = useRef<ReturnType<typeof createPointLayerRenderer> | null>(null);
  const radioRendererRef = useRef<ReturnType<typeof createPointLayerRenderer> | null>(null);
  const infrastructureRendererRef = useRef<ReturnType<typeof createInfrastructureRenderer> | null>(null);
  const coreRuntimeRef = useRef<ReturnType<typeof createCoreLiveWorld> | null>(null);
  const streetFallbackAbortRef = useRef<AbortController | null>(null);
  const streetPointRef = useRef<EarthPoint>(INITIAL_CENTER);

  const [cesiumReady, setCesiumReady] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [tleRecords, setTleRecords] = useState<TleRecord[]>([]);
  const [aircraft, setAircraft] = useState<SpatialEntity[]>([]);
  const [military, setMilitary] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(true);
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [satelliteCatalog, setSatelliteCatalog] = useState<SatelliteCatalog>("core");
  const [satelliteFilter, setSatelliteFilter] = useState<SatelliteFilter>("all");
  const [satelliteMeta, setSatelliteMeta] = useState<SatelliteFeedMeta | null>(null);
  const [aircraftLayer, setAircraftLayer] = useState(true);
  const [militaryLayer, setMilitaryLayer] = useState(true);
  const [trafficLayer, setTrafficLayer] = useState(true);
  const [eventLayer, setEventLayer] = useState(false);
  const [auroraLayer, setAuroraLayer] = useState(false);
  const [weatherLayer, setWeatherLayer] = useState(false);
  const [radioLayer, setRadioLayer] = useState(false);
  const [infrastructureLayer, setInfrastructureLayer] = useState(false);
  const [eventFilter, setEventFilter] = useState<(typeof EVENT_FILTERS)[number]>("all");
  const [radioFilter, setRadioFilter] = useState<(typeof RADIO_FILTERS)[number]>("all");
  const [infraFilters, setInfraFilters] = useState<InfrastructureCategory[]>(INFRA_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [earthquakeState, setEarthquakeState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [aircraftState, setAircraftState] = useState<LoadState>("idle");
  const [aircraftMeta, setAircraftMeta] = useState<AircraftFeedMeta | null>(null);
  const [militaryState, setMilitaryState] = useState<LoadState>("idle");
  const [militaryMeta, setMilitaryMeta] = useState<MilitaryFeedMeta | null>(null);
  const [trafficState, setTrafficState] = useState<LoadState>("idle");
  const [trafficVehicleCount, setTrafficVehicleCount] = useState(0);
  const [naturalEvents, setNaturalEvents] = useState<SpatialEntity[]>([]);
  const [aurora, setAurora] = useState<SpatialEntity[]>([]);
  const [weather, setWeather] = useState<SpatialEntity[]>([]);
  const [radioStations, setRadioStations] = useState<SpatialEntity[]>([]);
  const [infrastructure, setInfrastructure] = useState<InfrastructureFeature[]>([]);
  const [eventState, setEventState] = useState<LoadState>("idle");
  const [auroraState, setAuroraState] = useState<LoadState>("idle");
  const [weatherState, setWeatherState] = useState<LoadState>("idle");
  const [radioState, setRadioState] = useState<LoadState>("idle");
  const [infrastructureState, setInfrastructureState] = useState<LoadState>("idle");
  const [spaceKp, setSpaceKp] = useState<number | null>(null);
  const [spaceLaunches, setSpaceLaunches] = useState<SpaceLaunch[]>([]);
  const [spaceLaunchState, setSpaceLaunchState] = useState<LoadState>("idle");
  const [eventRetry, setEventRetry] = useState(0);
  const [auroraRetry, setAuroraRetry] = useState(0);
  const [weatherRetry, setWeatherRetry] = useState(0);
  const [radioRetry, setRadioRetry] = useState(0);
  const [infrastructureRetry, setInfrastructureRetry] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [searchMessage, setSearchMessage] = useState("");
  const [searchTarget, setSearchTarget] = useState<PlaceSearchResult | null>(null);
  const [viewCenter, setViewCenter] = useState<EarthPoint>(INITIAL_CENTER);
  const [cameraHeight, setCameraHeight] = useState(9_500_000);
  const [followAircraft, setFollowAircraft] = useState(false);
  const [selected, setSelected] = useState<SpatialEntity | null>(null);
  const [hovered, setHovered] = useState<SpatialEntity | null>(null);
  const [hoveredScreen, setHoveredScreen] = useState<{ x: number; y: number } | null>(null);
  const [issPreview, setIssPreview] = useState<{ entity: SpatialEntity; screen: { x: number; y: number } | null } | null>(null);
  const [timeOffsetDays, setTimeOffsetDays] = useState(0);
  const [spacePlaybackDays, setSpacePlaybackDays] = useState(0);

  const [spacePlaying, setSpacePlaying] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [layerErrors, setLayerErrors] = useState<LayerError>({});
  const [streetPhotos, setStreetPhotos] = useState<StreetPhoto[]>([]);
  const [streetIndex, setStreetIndex] = useState(0);
  const [streetState, setStreetState] = useState<LoadState>("idle");
  const [streetOpen, setStreetOpen] = useState(false);
  const [streetTarget, setStreetTarget] = useState<EarthPoint | null>(null);
  const [annotations, setAnnotations] = useState<Array<{ id: string; latitude: number; longitude: number; label: string }>>([]);
  const [streetProvider, setStreetProvider] = useState<StreetProvider>(GOOGLE_MAPS_API_KEY ? "google" : "kartaview");
  const [streetNotice, setStreetNotice] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<WorldMapMode>("satellite");
  const [threeDError, setThreeDError] = useState<string | null>(null);
  const [earthHandoff, setEarthHandoff] = useState<{ latitude: number; longitude: number; height: number; mapMode: WorldMapMode } | null>(null);
  const [frameHandoff, setFrameHandoff] = useState<"earth-to-space" | "space-to-earth" | null>(null);
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [timeCollapsed, setTimeCollapsed] = useState(false);
  const [planetOrbits, setPlanetOrbits] = useState(false);

  const selectedTime = useMemo(
    () => new Date((timeOffsetDays === 0 ? nowTick : Date.now()) + (timeOffsetDays + spacePlaybackDays) * DAY_MS),
    [timeOffsetDays, spacePlaybackDays, nowTick],
  );
  const satellites = useMemo(() => propagateTles(tleRecords, selectedTime), [tleRecords, selectedTime]);
  const satelliteClassCounts = useMemo(() => tallySatelliteClasses(satellites), [satellites]);

  useEffect(() => {
    if (viewMode !== "space") return;
    const controller = new AbortController();
    setSpaceLaunchState("loading");
    fetchRecentLaunches(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setSpaceLaunches(items);
        setSpaceLaunchState(items.length ? "ready" : "degraded");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSpaceLaunchState("error");
      });
    return () => controller.abort();
  }, [viewMode]);
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);
  const aircraftAvailable = viewMode === "earth" && timeOffsetDays === 0 && spacePlaybackDays === 0;
  const visibleAircraft = useMemo(() => {
    const byId = new Map<string, SpatialEntity>();
    if (aircraftLayer) for (const item of aircraft) byId.set(item.id, item);
    if (militaryLayer) for (const item of military) byId.set(item.id, item);
    return [...byId.values()];
  }, [aircraftLayer, aircraft, militaryLayer, military]);

  // Render every unique contact already held by the data layer. Camera zoom is
  // a pure LOD/view concern and must never decide which contacts are fetched.
  const renderedAircraft = visibleAircraft;
  const animateAircraft = cameraHeight < 900_000;
  const streetPoint = streetTarget ?? (
    selected && selected.kind !== "celestial-body"
      ? { latitude: selected.position.latitude, longitude: selected.position.longitude }
      : viewCenter
  );
  useEffect(() => {
    streetPointRef.current = streetPoint;
  }, [streetPoint.latitude, streetPoint.longitude]);
  const filteredEvents = useMemo(
    () => eventFilter === "all" ? naturalEvents : naturalEvents.filter((item) => item.properties.category === eventFilter),
    [naturalEvents, eventFilter],
  );
  const filteredRadio = useMemo(
    () => radioStations.filter((item) => radioMatches(item, radioFilter)),
    [radioStations, radioFilter],
  );
  const infrastructureCounts = useMemo(() => {
    const counts: Record<InfrastructureCategory, number> = { cable: 0, landing: 0, datacenter: 0, dam: 0 };
    for (const item of infrastructure) counts[item.category] += 1;
    return counts;
  }, [infrastructure]);
  const keylessCenter = useMemo(() => ({
    latitude: Math.round(viewCenter.latitude * 4) / 4,
    longitude: Math.round(viewCenter.longitude * 4) / 4,
  }), [viewCenter.latitude, viewCenter.longitude]);

  const setLayerError = useCallback((key: keyof LayerError, message?: string) => {
    setLayerErrors((current) => ({ ...current, [key]: message }));
  }, []);

  const selectEntity = useCallback((entity: SpatialEntity) => {
    setSelected(entity);
    setStreetTarget(null);
    setMobilePanel("inspector");
    if (entity.kind === "satellite" && /ISS.*ZARYA|^ISS\b/i.test(entity.name)) {
      setIssPreview({ entity, screen: null });
    } else {
      setIssPreview(null);
    }
  }, []);

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 760px)").matches);
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  // Keep the React/UI clock deliberately slow. The hot live motion path below
  // updates Cesium directly so the entire application tree is not reconciled
  // every second just to move satellites or nearby aircraft.
  useEffect(() => {
    if (viewMode !== "earth" || timeOffsetDays !== 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), UI_CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [viewMode, timeOffsetDays]);

  useEffect(() => {
    if (
      viewMode !== "earth" ||
      timeOffsetDays !== 0 ||
      spacePlaybackDays !== 0 ||
      !cesiumReady ||
      !((aircraftLayer || militaryLayer) && aircraftAvailable && animateAircraft)
    ) return;

    const tick = () => {
      const nowMs = Date.now();
      aircraftRendererRef.current?.sync({
        items: renderedAircraft,
        visible: true,
        selectedId: selected?.kind === "aircraft" ? selected.id : null,
        followSelected: followAircraft,
        nowMs,
        cameraHeight,
        mapMode,
      });
      const viewer = viewerRef.current;
      const Cesium = window.Cesium;
      if (viewer && Cesium) viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(nowMs));
    };

    tick();
    const timer = window.setInterval(tick, isMobile ? MOBILE_LIVE_MOTION_TICK_MS : LIVE_MOTION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [
    viewMode,
    timeOffsetDays,
    spacePlaybackDays,
    cesiumReady,
    aircraftLayer,
    militaryLayer,
    aircraftAvailable,
    animateAircraft,
    renderedAircraft,
    selected?.id,
    selected?.kind,
    followAircraft,
    isMobile,
    cameraHeight,
    mapMode,
  ]);

  useEffect(() => {
    if (viewMode !== "space" || !spacePlaying) return;
    const tickMs = 250;
    const timer = window.setInterval(() => {
      setSpacePlaybackDays((days) => days + (tickMs / 1000));
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [viewMode, spacePlaying]);

  useEffect(() => {
    if (viewMode !== "space" && spacePlaying) setSpacePlaying(false);
  }, [viewMode, spacePlaying]);

  useEffect(() => {
    const runtime = createCoreLiveWorld();
    coreRuntimeRef.current = runtime;

    const unsubscribe = runtime.subscribe((snapshot) => {
      setEarthquakes(snapshot.earthquakes.data);
      setEarthquakeState(snapshot.earthquakes.status);
      setLayerError("earthquakes", snapshot.earthquakes.error);

      setTleRecords(snapshot.satellites.data);
      setSatelliteMeta(snapshot.satellites.meta);
      setSatelliteState(snapshot.satellites.status);
      setLayerError("satellites", snapshot.satellites.error);

      setAircraft(snapshot.aircraft.data);
      setAircraftMeta(snapshot.aircraft.meta);
      setAircraftState(snapshot.aircraft.status);
      setLayerError("aircraft", snapshot.aircraft.error);

      setMilitary(snapshot.military.data);
      setMilitaryMeta(snapshot.military.meta);
      setMilitaryState(snapshot.military.status);
      setLayerError("military", snapshot.military.error);
    });

    runtime.setAircraftContext({
      latitude: INITIAL_CENTER.latitude,
      longitude: INITIAL_CENTER.longitude,
    });
    runtime.start();
    return () => {
      unsubscribe();
      runtime.destroy();
      if (coreRuntimeRef.current === runtime) coreRuntimeRef.current = null;
    };
  }, [setLayerError]);

  useEffect(() => {
    coreRuntimeRef.current?.setAircraftContext({
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
    });
  }, [viewCenter.latitude, viewCenter.longitude]);

  useEffect(() => {
    coreRuntimeRef.current?.setSatelliteCatalog(satelliteCatalog);
  }, [satelliteCatalog]);


  useEffect(() => {
    if (!eventLayer) { setEventState("idle"); return; }
    const controller = new AbortController();
    setEventState("loading");
    fetchNaturalEvents(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setNaturalEvents(items);
        setEventState(items.length ? "ready" : "error");
        setLayerError("events", items.length ? undefined : "NASA EONET returned no open events");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setEventState("error");
        setLayerError("events", error instanceof Error ? error.message : "NASA EONET unavailable");
      });
    return () => controller.abort();
  }, [eventLayer, eventRetry, setLayerError]);

  useEffect(() => {
    if (!auroraLayer) { setAuroraState("idle"); return; }
    const controller = new AbortController();
    setAuroraState("loading");
    fetchAurora(controller.signal)
      .then(({ items, kp }) => {
        if (controller.signal.aborted) return;
        setAurora(items);
        setSpaceKp(kp);
        setAuroraState(items.length ? "ready" : "degraded");
        setLayerError("aurora", items.length ? undefined : "NOAA SWPC returned no visible aurora cells");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setAuroraState("error");
        setLayerError("aurora", error instanceof Error ? error.message : "NOAA SWPC unavailable");
      });
    return () => controller.abort();
  }, [auroraLayer, auroraRetry, setLayerError]);

  useEffect(() => {
    if (!weatherLayer) { setWeatherState("idle"); return; }
    const controller = new AbortController();
    setWeatherState("loading");
    fetchWeather(keylessCenter.latitude, keylessCenter.longitude, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setWeather(items);
        setWeatherState(items.length ? "ready" : "error");
        setLayerError("weather", items.length ? undefined : "Open-Meteo returned no observation");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWeatherState("error");
        setLayerError("weather", error instanceof Error ? error.message : "Open-Meteo unavailable");
      });
    return () => controller.abort();
  }, [weatherLayer, weatherRetry, keylessCenter.latitude, keylessCenter.longitude, setLayerError]);

  useEffect(() => {
    if (!radioLayer) { setRadioState("idle"); return; }
    const controller = new AbortController();
    setRadioState("loading");
    fetchRadioStations(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setRadioStations(items);
        setRadioState(items.length ? "ready" : "error");
        setLayerError("radio", items.length ? undefined : "Radio Browser returned no geolocated HTTPS stations");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setRadioState("error");
        setLayerError("radio", error instanceof Error ? error.message : "Radio Browser unavailable");
      });
    return () => controller.abort();
  }, [radioLayer, radioRetry, setLayerError]);

  useEffect(() => {
    if (!infrastructureLayer) { setInfrastructureState("idle"); return; }
    const controller = new AbortController();
    setInfrastructureState("loading");
    loadInfrastructureBaseline(controller.signal)
      .then((baseline) => {
        if (controller.signal.aborted) return;
        setInfrastructure(baseline.features);
        setInfrastructureState(baseline.errors.length ? "degraded" : "ready");
        setLayerError("infrastructure", baseline.errors.length ? baseline.errors.join(" · ") : undefined);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setInfrastructureState("error");
        setLayerError("infrastructure", error instanceof Error ? error.message : "Bundled infrastructure baseline unavailable");
      });
    return () => controller.abort();
  }, [infrastructureLayer, infrastructureRetry, setLayerError]);



  useEffect(() => {
    if (!cesiumReady || !containerRef.current || !window.Cesium || viewerRef.current) return;
    const lifecycle = createWorldViewer({
      Cesium: window.Cesium,
      container: containerRef.current,
      onViewChange: ({ latitude, longitude, height }) => {
        setViewCenter({ latitude, longitude });
        setCameraHeight(height);
      },
      onEntityClick: (id) => {
        const spatial = entityMapRef.current.get(id);
        if (spatial) selectEntity(spatial);
      },
      onEntityHover: (id, screen) => {
        const spatial = id ? entityMapRef.current.get(id) ?? null : null;
        setHovered(spatial);
        setHoveredScreen(spatial ? screen : null);
      },
      onEmptyClick: (point) => {
        setSelected(null);
        setFollowAircraft(false);
        if (point) {
          streetPointRef.current = point;
          setStreetTarget(point);
          setStreetNotice(`Street target set · ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`);
        }
      },
      onMapModeFallback: (error) => {
        setThreeDError(error);
        setMapMode("satellite");
      },
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
      cesiumIonToken: CESIUM_ION_TOKEN,
    });
    viewerLifecycleRef.current = lifecycle;
    viewerRef.current = lifecycle.viewer;
    earthquakeRendererRef.current = createEarthquakeRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
    });
    satelliteRendererRef.current = createSatelliteRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
    });
    aircraftRendererRef.current = createAircraftRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
    });
    trafficControllerRef.current = createTrafficController({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      onState: ({ state, error, vehicleCount }) => {
        setTrafficState(state);
        setTrafficVehicleCount(vehicleCount);
        setLayerError("traffic", error);
      },
    });
    celestialBridgeRendererRef.current = createCelestialBridgeRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
    });
    eventRendererRef.current = createPointLayerRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
      styleFor: (item) => {
        const category = String(item.properties.category ?? "other");
        const color = category === "fire" ? "#fb923c" : category === "storm" ? "#60a5fa" : category === "volcano" ? "#ef4444" : category === "flood" ? "#22d3ee" : category === "ice" ? "#e0f2fe" : "#c084fc";
        return { color, pixelSize: 9, clampToGround: true, disableDepthTestDistance: 3000 };
      },
    });
    auroraRendererRef.current = createPointLayerRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
      styleFor: (item) => ({ color: "#4ade80", pixelSize: Math.max(3, Math.min(10, Number(item.properties.probability ?? 0) / 10)), altitudeMeters: 110_000, disableDepthTestDistance: 0 }),
    });
    radioRendererRef.current = createPointLayerRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
      styleFor: () => ({ color: "#f472b6", pixelSize: 6, clampToGround: true, disableDepthTestDistance: 2500 }),
    });
    infrastructureRendererRef.current = createInfrastructureRenderer({
      viewer: lifecycle.viewer,
      Cesium: window.Cesium,
      entityRegistry: entityMapRef.current,
    });

    return () => {
      earthquakeRendererRef.current?.destroy();
      satelliteRendererRef.current?.destroy();
      aircraftRendererRef.current?.destroy();
      trafficControllerRef.current?.destroy();
      celestialBridgeRendererRef.current?.destroy();
      eventRendererRef.current?.destroy();
      auroraRendererRef.current?.destroy();
      radioRendererRef.current?.destroy();
      infrastructureRendererRef.current?.destroy();
      earthquakeRendererRef.current = null;
      satelliteRendererRef.current = null;
      aircraftRendererRef.current = null;
      trafficControllerRef.current = null;
      celestialBridgeRendererRef.current = null;
      eventRendererRef.current = null;
      auroraRendererRef.current = null;
      radioRendererRef.current = null;
      infrastructureRendererRef.current = null;
      lifecycle.destroy();
      viewerLifecycleRef.current = null;
      viewerRef.current = null;
    };
  }, [cesiumReady, selectEntity]);

  useEffect(() => {
    if (viewMode !== "earth") return;
    viewerLifecycleRef.current?.setMapStyle(cameraHeight < 350_000 ? "ground" : "earth");
  }, [cameraHeight, viewMode]);

  useEffect(() => {
    if (viewMode !== "earth") return;
    let cancelled = false;
    void viewerLifecycleRef.current?.setMapMode(mapMode).then((result) => {
      if (cancelled || !result) return;
      if (mapMode === "photoreal" && result.ok) setThreeDError(null);
      if (!result.ok) {
        if (mapMode === "photoreal") {
          setThreeDError(result.error ?? "Google Photorealistic 3D is unavailable");
        }
        if (result.activeMode !== mapMode) setMapMode(result.activeMode);
      }
    });
    return () => { cancelled = true; };
  }, [viewMode, mapMode, cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const markerId = "street-target-marker";
    if (!viewer || !Cesium) return;

    viewer.entities.removeById(markerId);
    if (!streetTarget || viewMode !== "earth") return;

    viewer.entities.add({
      id: markerId,
      position: Cesium.Cartesian3.fromDegrees(streetTarget.longitude, streetTarget.latitude, 0),
      point: {
        pixelSize: 11,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString("#0f172a"),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 10_000,
      },
      label: {
        text: "STREET",
        font: "600 11px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString("#020617"),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 10_000,
      },
    });

    return () => {
      if (viewerRef.current) viewerRef.current.entities.removeById(markerId);
    };
  }, [streetTarget?.latitude, streetTarget?.longitude, viewMode, cesiumReady]);

  useEffect(() => {
    if (
      viewMode === "earth" &&
      selected?.kind === "celestial-body" &&
      !selected.id.startsWith("bridge:")
    ) {
      setSelected(null);
      setFollowAircraft(false);
    }
  }, [viewMode, selected?.kind, selected?.id]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const markerId = "search-target";
    if (!viewer || !Cesium) return;
    viewer.entities.removeById(markerId);
    if (!searchTarget || viewMode !== "earth") return;

    viewer.entities.add({
      id: markerId,
      position: Cesium.Cartesian3.fromDegrees(searchTarget.longitude, searchTarget.latitude, 0),
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString("#22d3ee"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 25_000,
      },
      label: {
        text: searchTarget.label.split(",")[0],
        font: "700 14px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString("#020617"),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -24),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 25_000,
      },
    });

    return () => { viewer.entities.removeById(markerId); };
  }, [searchTarget?.id, searchTarget?.latitude, searchTarget?.longitude, viewMode, cesiumReady]);

  const switchMapMode = useCallback((mode: WorldMapMode) => {
    setStreetOpen(false);
    setThreeDError(mode === "photoreal"
      ? "Google Photorealistic 3D · loading and verifying live tiles…"
      : null);
    setMapMode(mode);
  }, []);



  useEffect(() => {
    earthquakeRendererRef.current?.sync(
      earthquakes,
      viewMode === "earth" && earthquakeLayer,
    );
  }, [earthquakes, earthquakeLayer, viewMode, cesiumReady]);

  useEffect(() => {
    satelliteRendererRef.current?.sync({
      satellites,
      tleRecords,
      catalog: satelliteCatalog,
      visible: viewMode === "earth" && satelliteLayer,
      selectedId: selected?.kind === "satellite" ? selected.id : null,
      isMobile,
      cameraHeight,
      time: selectedTime,
      continuous: timeOffsetDays === 0 && spacePlaybackDays === 0,
      filter: satelliteFilter,
    });
  }, [satellites, tleRecords, satelliteCatalog, satelliteFilter, satelliteLayer, viewMode, cesiumReady, isMobile, cameraHeight, selected?.id, selected?.kind, selectedTime, timeOffsetDays, spacePlaybackDays]);



  useEffect(() => {
    aircraftRendererRef.current?.sync({
      items: renderedAircraft,
      visible: viewMode === "earth" && (aircraftLayer || militaryLayer) && aircraftAvailable,
      selectedId: selected?.kind === "aircraft" ? selected.id : null,
      followSelected: followAircraft,
      nowMs: nowTick,
      cameraHeight,
      mapMode,
    });
  }, [renderedAircraft, aircraftLayer, militaryLayer, aircraftAvailable, viewMode, cesiumReady, nowTick, cameraHeight, mapMode, selected?.id, selected?.kind, followAircraft]);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium || viewMode !== "earth") return;
    const live = new Set<string>();
    for (const annotation of annotations) {
      const id = `annotation:${annotation.id}`;
      live.add(id);
      if (viewer.entities.getById(id)) continue;
      annotationIdsRef.current.add(id);
      viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(annotation.longitude, annotation.latitude, 15),
        point: { pixelSize: 10, color: Cesium.Color.fromCssColorString("#fb923c"), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: annotation.label, font: "11px sans-serif", fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(10, -11), showBackground: true, backgroundColor: Cesium.Color.fromCssColorString("#111827").withAlpha(0.72) },
      });
    }
    for (const id of Array.from(annotationIdsRef.current) as string[]) {
      if (!live.has(id)) { viewer.entities.removeById(id); annotationIdsRef.current.delete(id); }
    }
  }, [annotations, viewMode, cesiumReady]);



  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium || viewMode !== "earth") return;
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(selectedTime);
    viewer.scene?.requestRender?.();
  }, [selectedTime, viewMode, cesiumReady]);

  useEffect(() => {
    celestialBridgeRendererRef.current?.sync({
      planets,
      visible: viewMode === "earth" && cameraHeight >= CELESTIAL_CONTEXT_HEIGHT_M,
      cameraHeight,
      selectedId: selected?.kind === "celestial-body" ? selected.id : null,
      showOrbits: planetOrbits,
    });
  }, [planets, viewMode, cameraHeight, selected?.id, selected?.kind, planetOrbits, cesiumReady]);

  useEffect(() => {
    trafficControllerRef.current?.sync({
      enabled: trafficLayer,
      earthVisible: viewMode === "earth",
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
      cameraHeight,
      mapMode,
    });
  }, [trafficLayer, viewMode, viewCenter.latitude, viewCenter.longitude, cameraHeight, mapMode, cesiumReady]);

  useEffect(() => {
    eventRendererRef.current?.sync(filteredEvents, viewMode === "earth" && eventLayer);
  }, [filteredEvents, eventLayer, viewMode, cesiumReady]);

  useEffect(() => {
    auroraRendererRef.current?.sync(aurora, viewMode === "earth" && auroraLayer);
  }, [aurora, auroraLayer, viewMode, cesiumReady]);

  useEffect(() => {
    radioRendererRef.current?.sync(filteredRadio, viewMode === "earth" && radioLayer);
  }, [filteredRadio, radioLayer, viewMode, cesiumReady]);

  useEffect(() => {
    infrastructureRendererRef.current?.sync(
      infrastructure,
      viewMode === "earth" && infrastructureLayer,
      new Set(infraFilters),
      mapMode,
    );
  }, [infrastructure, infrastructureLayer, infraFilters, viewMode, mapMode, cesiumReady]);


  useEffect(() => {
    if (viewMode === "earth") return;
    earthquakeRendererRef.current?.clear();
    aircraftRendererRef.current?.clear();
  }, [viewMode]);



  const enterSpaceFromEarth = useCallback(() => {
    if (viewMode !== "earth" || streetOpen) return;
    if (mapMode === "photoreal") {
      void viewerLifecycleRef.current?.setMapMode("satellite");
      setMapMode("satellite");
    }
    setEarthHandoff({
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
      height: cameraHeight,
      mapMode,
    });
    setFrameHandoff("earth-to-space");
    setFollowAircraft(false);
    setSelected(null);
    setMobilePanel("none");
    setViewMode("space");
    window.setTimeout(() => setFrameHandoff(null), 520);
  }, [viewMode, streetOpen, mapMode, viewCenter.latitude, viewCenter.longitude, cameraHeight]);

  const returnToEarthFromSpace = useCallback(() => {
    const handoff = earthHandoff ?? {
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
      height: 6_500_000,
      mapMode,
    };
    setFrameHandoff("space-to-earth");
    setViewMode("earth");
    setFollowAircraft(false);
    setSelected(null);
    setMapMode(handoff.mapMode);
    viewerLifecycleRef.current?.setMapStyle("earth");
    viewerLifecycleRef.current?.setMapMode(handoff.mapMode);

    window.setTimeout(() => {
      const viewer = viewerRef.current;
      const Cesium = window.Cesium;
      if (viewer && Cesium) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            handoff.longitude,
            handoff.latitude,
            Math.max(4_500_000, Math.min(handoff.height, 12_000_000)),
          ),
          duration: 0.9,
        });
      }
      setFrameHandoff(null);
    }, 40);
  }, [earthHandoff, viewCenter.latitude, viewCenter.longitude, mapMode]);

  const flyEarth = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false); setSelected(null);
    viewerLifecycleRef.current?.setMapStyle("earth");
    viewerLifecycleRef.current?.home();
  }, [viewCenter.latitude, viewCenter.longitude]);

  const flyGround = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false); setSelected(null);
    viewerLifecycleRef.current?.setMapStyle("ground");
    viewerLifecycleRef.current?.flyTo({ latitude: viewCenter.latitude, longitude: viewCenter.longitude, height: 18_000 });
  }, [viewCenter.latitude, viewCenter.longitude]);

  const goToPlace = useCallback((place: PlaceSearchResult, keepAlternatives = false) => {
    setSearchQuery(place.label);
    if (!keepAlternatives) setSearchResults([]);
    setSearchMessage(keepAlternatives ? "Showing best match · choose another result if needed" : "");
    setSearchTarget(place);
    setViewMode("earth");
    setSelected(null);
    setFollowAircraft(false);
    viewerLifecycleRef.current?.flyTo({
      latitude: place.latitude,
      longitude: place.longitude,
      height: place.heightMeters,
    });
  }, []);

  const runPlaceSearch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearchState("loading");
    setSearchMessage("");
    try {
      const results = await searchPlaces(query);
      setSearchState("idle");
      if (!results.length) {
        setSearchResults([]);
        setSearchTarget(null);
        setSearchMessage("No place found");
        return;
      }

      const explicitQuery = /^[+-]?\d+(?:\.\d+)?\s*[,;]\s*[+-]?\d+(?:\.\d+)?$/.test(query);
      if (results.length === 1 || explicitQuery) {
        setSearchResults(results.length > 1 ? results : []);
        goToPlace(results[0], results.length > 1);
      } else {
        setSearchResults(results);
        setSearchMessage("Multiple matches · choose a result");
      }
    } catch (error) {
      setSearchResults([]);
      setSearchState("error");
      setSearchMessage(error instanceof Error ? error.message : "Place search unavailable");
    }
  }, [searchQuery, goToPlace]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchMessage("");
    setSearchState("idle");
    setSearchTarget(null);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const focusSelected = useCallback(() => {
    if (!selected || selected.kind === "celestial-body" || !viewerRef.current || !window.Cesium) return;
    const Cesium = window.Cesium;
    const altitude = selected.kind === "satellite" ? Math.max(1_000_000, selected.position.altitudeMeters * 1.8)
      : selected.kind === "aircraft" ? 180_000 : 700_000;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(selected.position.longitude, selected.position.latitude, altitude), duration: 1.2,
    });
  }, [selected]);

  const loadKartaViewStreet = useCallback((fallbackReason?: string) => {
    const point = streetPointRef.current;
    streetFallbackAbortRef.current?.abort();
    const controller = new AbortController();
    streetFallbackAbortRef.current = controller;
    setStreetProvider("kartaview");
    setStreetState("loading");
    setStreetIndex(0);
    setStreetPhotos([]);
    setStreetNotice(fallbackReason ?? "Searching KartaView nearby imagery…");
    setLayerError("street", fallbackReason);
    fetchStreetPhotos(point.latitude, point.longitude, controller.signal)
      .then((photos) => {
        if (controller.signal.aborted) return;
        setStreetPhotos(photos);
        setStreetState(photos.length ? "ready" : "error");
        setStreetNotice(photos.length
          ? `KartaView · ${photos.length} nearby image${photos.length === 1 ? "" : "s"}`
          : "No KartaView imagery found near this point");
        setLayerError("street", photos.length ? undefined : "No KartaView coverage near this point");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "Street imagery error";
        setStreetState("error");
        setStreetNotice(message);
        setLayerError("street", message);
      })
      .finally(() => {
        if (streetFallbackAbortRef.current === controller) streetFallbackAbortRef.current = null;
      });
  }, [setLayerError]);

  const openStreet = useCallback(() => {
    if (viewMode !== "earth") return;
    streetPointRef.current = streetPoint;
    streetFallbackAbortRef.current?.abort();
    streetFallbackAbortRef.current = null;
    setStreetTarget(streetPoint);
    setStreetOpen(true);
    setMobilePanel("street");
    setStreetIndex(0);
    setStreetPhotos([]);
    setLayerError("street");

    if (GOOGLE_MAPS_API_KEY) {
      setStreetProvider("google");
      setStreetState("loading");
      setStreetNotice(`Google Street View · searching near ${streetPoint.latitude.toFixed(5)}, ${streetPoint.longitude.toFixed(5)}`);
    } else {
      loadKartaViewStreet("Google Street View is not configured for this preview · using KartaView");
    }
  }, [viewMode, setLayerError, streetPoint.latitude, streetPoint.longitude, loadKartaViewStreet]);

  const handleGoogleStreetReady = useCallback(() => {
    setStreetState("ready");
    setStreetNotice("Google Street View · interactive panorama");
    setLayerError("street");
  }, [setLayerError]);

  const handleGoogleStreetFallback = useCallback((message: string) => {
    loadKartaViewStreet(`${message} · using KartaView fallback`);
  }, [loadKartaViewStreet]);

  const handleGoogleStreetPosition = useCallback((point: EarthPoint) => {
    streetPointRef.current = point;
    setStreetTarget(point);
  }, []);

  const closeStreet = useCallback(() => {
    streetFallbackAbortRef.current?.abort();
    streetFallbackAbortRef.current = null;
    setStreetOpen(false);
    setStreetTarget(null);
    setStreetPhotos([]);
    setStreetIndex(0);
    setStreetState("idle");
    setStreetNotice(null);
    setStreetProvider(GOOGLE_MAPS_API_KEY ? "google" : "kartaview");
    setLayerError("street");
    setMobilePanel("none");
  }, [setLayerError]);
  const clearSelection = useCallback(() => {
    setSelected(null);
    setFollowAircraft(false);
    aircraftRendererRef.current?.clearTracking();
  }, []);
  const addAnnotation = () => {
    const label = window.prompt("Annotation label", "Marker");
    if (!label?.trim()) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAnnotations((current) => [...current, { id, latitude: streetPoint.latitude, longitude: streetPoint.longitude, label: label.trim().slice(0, 48) }]);
  };
  const resetTime = () => { setTimeOffsetDays(0); setSpacePlaybackDays(0); setSpacePlaying(false); setNowTick(Date.now()); };
  const retryLayer = (layer: "earthquakes" | "satellites" | "aircraft" | "military" | "traffic") => {
    if (layer === "traffic") {
      trafficControllerRef.current?.retry();
      return;
    }
    coreRuntimeRef.current?.retry(layer);
  };
  const toggleEarthquakeLayer = (enabled: boolean) => {
    setEarthquakeLayer(enabled);
    coreRuntimeRef.current?.setEnabled("earthquakes", enabled);
  };
  const toggleSatelliteLayer = (enabled: boolean) => {
    setSatelliteLayer(enabled);
    coreRuntimeRef.current?.setEnabled("satellites", enabled);
  };
  const toggleAircraftLayer = (enabled: boolean) => {
    setAircraftLayer(enabled);
    coreRuntimeRef.current?.setEnabled("aircraft", enabled);
  };
  const toggleMilitaryLayer = (enabled: boolean) => {
    setMilitaryLayer(enabled);
    coreRuntimeRef.current?.setEnabled("military", enabled);
  };
  const togglePanel = (panel: Exclude<MobilePanel, "none">) => setMobilePanel((current) => current === panel ? "none" : panel);
  const currentStreet = streetPhotos[streetIndex] ?? null;

  return (
    <main className="shell">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css" />
      <Script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js" strategy="afterInteractive" onLoad={() => setCesiumReady(true)} onError={() => setLayerError("earthquakes", "CesiumJS could not be loaded")} />

      <div ref={containerRef} className={`globe ${viewMode === "space" ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SpaceExplorer
        planets={planets}
        satellites={satellites}
        sun={sun}
        time={selectedTime}
        launches={spaceLaunches}
        launchState={spaceLaunchState}
        onSelect={selectEntity}
        onReturnEarth={returnToEarthFromSpace}
        earthHandoff={earthHandoff}
      />}

      <header className="topbar glass">
        <div className="brand"><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" && cameraHeight >= GROUND_HEIGHT_M ? "active" : ""} onClick={viewMode === "space" ? returnToEarthFromSpace : flyEarth}>EARTH</button>
          <button className={viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "active" : ""} onClick={flyGround}>GROUND</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={enterSpaceFromEarth}>SPACE</button>
        </div>
        <div className="statusRow"><span className="statusDot" /><span>ws-pv · GEV F1 · {viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "GROUND" : viewMode.toUpperCase()}</span></div>
      </header>

      {viewMode === "earth" && <div className="mapNav glass">
        <form className="placeSearch" onSubmit={runPlaceSearch}>
          <div className="placeSearchField">
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search city, address or coordinates"
              aria-label="Search city, address or coordinates"
            />
            {(searchQuery || searchResults.length > 0 || searchMessage || searchTarget) && (
              <button type="button" className="searchClear" onClick={clearSearch} aria-label="Clear search">×</button>
            )}
          </div>
          <button type="submit" disabled={searchState === "loading"}>{searchState === "loading" ? "…" : "GO"}</button>
        </form>
        <div className="orientationControls" role="group" aria-label="Map orientation">
          <button type="button" onClick={() => viewerLifecycleRef.current?.home()}>HOME</button>
          <button type="button" onClick={() => viewerLifecycleRef.current?.toggleTilt()}>TILT</button>
          <button type="button" onClick={() => viewerLifecycleRef.current?.northUp()}>NORTH</button>
        </div>
        {(searchResults.length > 0 || searchMessage) && <div className="searchResults">
          {searchMessage && <small>{searchMessage}</small>}
          {searchResults.map((place) => <button key={place.id} type="button" onClick={() => goToPlace(place)}>
            <strong>{place.label.split(",")[0]}</strong><span>{place.label}</span>
          </button>)}
        </div>}
      </div>}

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""} ${!isMobile && layersCollapsed ? "panelCollapsed" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><div className="panelHeadActions"><button className="panelCollapse" type="button" aria-expanded={!layersCollapsed} onClick={() => setLayersCollapsed((value) => !value)}>{layersCollapsed ? "›" : "‹"}</button><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div></div>
        <div className="basemapSwitch" role="group" aria-label="Basemap mode">
          <button className={mapMode === "satellite" ? "active" : ""} onClick={() => switchMapMode("satellite")}>SAT</button>
          <button className={mapMode === "map" ? "active" : ""} onClick={() => switchMapMode("map")}>MAP</button>
          <button className={mapMode === "nasa" ? "active" : ""} onClick={() => switchMapMode("nasa")}>NASA EO</button>
          <button className={mapMode === "photoreal" ? "active" : ""} disabled={!GOOGLE_MAPS_API_KEY && !CESIUM_ION_TOKEN} onClick={() => switchMapMode("photoreal")}>3D</button>
        </div>
        {!GOOGLE_MAPS_API_KEY && <div className="mapModeNotice">Google Street View is not configured on this preview. KartaView remains available manually.</div>}
        {threeDError && <div className="mapModeNotice">{threeDError}</div>}
        <LayerToggle checked={earthquakeLayer} onChange={toggleEarthquakeLayer} onRetry={() => retryLayer("earthquakes")} title="Earthquakes" subtitle="USGS · recent M2.5+ events" state={earthquakeState} count={earthquakes.length} disabled={viewMode !== "earth"} error={layerErrors.earthquakes} />
        <LayerToggle
          checked={satelliteLayer}
          onChange={toggleSatelliteLayer}
          onRetry={() => retryLayer("satellites")}
          title="Satellites"
          subtitle={satelliteCatalog === "dense"
            ? `CelesTrak DENSE · SGP4 · Starlink ${satelliteClassCounts.starlink}${satelliteMeta?.failedGroups.includes("STARLINK") ? " · SOURCE FAILED" : ""}`
            : "CelesTrak CORE · SGP4 · real altitude · horizon-aware"}
          state={satelliteState}
          count={satellites.length}
          disabled={viewMode !== "earth"}
          error={layerErrors.satellites}
        />
        <div className="satelliteCatalogSwitch" role="group" aria-label="Satellite catalog">
          <button className={satelliteCatalog === "core" ? "active" : ""} onClick={() => { setSatelliteCatalog("core"); setSatelliteFilter("all"); }}>CORE</button>
          <button className={satelliteCatalog === "dense" ? "active" : ""} onClick={() => setSatelliteCatalog("dense")}>DENSE</button>
        </div>
        {satelliteLayer && <div className="filterChips satelliteFilters">
          {SATELLITE_FILTERS.map((filter) => {
            const count = filter === "all" ? satellites.length : satelliteClassCounts[filter];
            if (filter !== "all" && count === 0 && satelliteCatalog === "core" && ["starlink","oneweb","iridium"].includes(filter)) return null;
            return <button
              key={filter}
              className={satelliteFilter === filter ? "active" : ""}
              onClick={() => setSatelliteFilter(filter)}
            >{filter.toUpperCase()} {count}</button>;
          })}
        </div>}
        {satelliteCatalog === "dense" && satelliteMeta && <div className="satelliteSourceStatus">
          <span>STARLINK {satelliteMeta.groupCounts.STARLINK ?? satelliteClassCounts.starlink}</span>
          <span>ONEWEB {satelliteMeta.groupCounts.ONEWEB ?? satelliteClassCounts.oneweb}</span>
          <span>IRIDIUM {satelliteMeta.groupCounts["IRIDIUM-NEXT"] ?? satelliteClassCounts.iridium}</span>
          {satelliteMeta.failedGroups.length > 0 && <strong>FAILED: {satelliteMeta.failedGroups.join(", ")}</strong>}
        </div>}
        <LayerToggle checked={aircraftLayer} onChange={toggleAircraftLayer} onRetry={() => retryLayer("aircraft")} title="Aircraft" subtitle={aircraftAvailable ? `ADS-B · ${aircraftMeta?.provider ?? "adsb.lol / OpenSky"} · stable coverage · all ${renderedAircraft.length} contacts rendered` : "NOW only"} state={aircraftState} count={aircraftAvailable ? renderedAircraft.length : 0} disabled={!aircraftAvailable} error={layerErrors.aircraft} />
        <LayerToggle checked={militaryLayer} onChange={toggleMilitaryLayer} onRetry={() => retryLayer("military")} title="Military" subtitle={aircraftAvailable ? `ADSB.lol · global military snapshot · ${militaryMeta?.stale ? "last-good" : "live"}` : "NOW only"} state={militaryState} count={aircraftAvailable ? military.length : 0} disabled={!aircraftAvailable} error={layerErrors.military} />
        <LayerToggle checked={trafficLayer} onChange={setTrafficLayer} onRetry={() => retryLayer("traffic")} title="Traffic" subtitle="AUTO near ground · OSM roads + modeled vehicles · TomTom when available" state={trafficState} count={trafficVehicleCount} disabled={viewMode !== "earth"} error={layerErrors.traffic} />
        <div className="layerGroupTitle">EVENTS</div>
        <LayerToggle checked={eventLayer} onChange={setEventLayer} onRetry={() => setEventRetry((v) => v + 1)} title="Natural Events" subtitle="NASA EONET · open events" state={eventState} count={filteredEvents.length} disabled={viewMode !== "earth"} error={layerErrors.events} />
        {eventLayer && <div className="filterChips">{EVENT_FILTERS.map((filter) => <button key={filter} className={eventFilter === filter ? "active" : ""} onClick={() => setEventFilter(filter)}>{filter.toUpperCase()}</button>)}</div>}
        <LayerToggle checked={auroraLayer} onChange={setAuroraLayer} onRetry={() => setAuroraRetry((v) => v + 1)} title="Space Weather" subtitle={spaceKp == null ? "NOAA SWPC · OVATION aurora" : `NOAA SWPC · OVATION · Kp ${spaceKp.toFixed(1)}`} state={auroraState} count={aurora.length} disabled={viewMode !== "earth"} error={layerErrors.aurora} />
        <LayerToggle checked={weatherLayer} onChange={setWeatherLayer} onRetry={() => setWeatherRetry((v) => v + 1)} title="Weather" subtitle="Open-Meteo · current focus conditions" state={weatherState} count={weather.length} disabled={viewMode !== "earth"} error={layerErrors.weather} />
        {weatherLayer && weather[0] && <div className="weatherContext">
          <strong>{weather[0].properties.temperatureC}°C</strong>
          <span>Wind {weather[0].properties.windKmh} km/h · Cloud {weather[0].properties.cloudCoverPct}%</span>
          <small>{viewCenter.latitude.toFixed(3)}, {viewCenter.longitude.toFixed(3)} · Open-Meteo</small>
        </div>}
        <div className="layerGroupTitle">INFRASTRUCTURE</div>
        <LayerToggle checked={infrastructureLayer} onChange={setInfrastructureLayer} onRetry={() => setInfrastructureRetry((v) => v + 1)} title="Infrastructure" subtitle={infrastructure.length ? "ws-donor · bundled infrastructure baseline" : "ws-donor · bundled baseline unavailable"} state={infrastructureState} count={infrastructure.length} disabled={viewMode !== "earth"} error={layerErrors.infrastructure} />
        {infrastructureLayer && <div className="filterChips">{INFRA_FILTERS.map((filter) => <button key={filter} className={infraFilters.includes(filter) ? "active" : ""} onClick={() => setInfraFilters((current) => current.includes(filter) ? current.filter((value) => value !== filter) : [...current, filter])}>{filter.toUpperCase()} {infrastructureCounts[filter]}</button>)}</div>}
        <div className="layerGroupTitle">UTILITIES</div>
        <LayerToggle checked={radioLayer} onChange={setRadioLayer} onRetry={() => setRadioRetry((v) => v + 1)} title="Radio" subtitle="Radio Browser · geolocated HTTPS stations" state={radioState} count={filteredRadio.length} disabled={viewMode !== "earth"} error={layerErrors.radio} />
        {radioLayer && <div className="filterChips">{RADIO_FILTERS.map((filter) => <button key={filter} className={radioFilter === filter ? "active" : ""} onClick={() => setRadioFilter(filter)}>{filter.replace("-", " ").toUpperCase()}</button>)}</div>}
        <label className={`layerRow ${viewMode !== "earth" ? "disabled" : ""}`}>
          <input type="checkbox" checked={planetOrbits} disabled={viewMode !== "earth" || cameraHeight < CELESTIAL_CONTEXT_HEIGHT_M} onChange={(event) => setPlanetOrbits(event.target.checked)} />
          <span><strong>Planet orbits</strong><small>{cameraHeight < CELESTIAL_CONTEXT_HEIGHT_M ? "Full-globe / orbital context only" : "Approximate JPL elements · physical AU/m scale"}</small></span>
          <b>{planetOrbits ? "ON" : ""}</b>
        </label>
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "PHYSICAL SCALE"}</em>
          <span>Ground map</span><em>ESRI STREET · WORLD SELECT LABELS EN</em>
          <span>Street imagery</span><em>GOOGLE + KARTAVIEW</em>
          <span>Annotations</span><em>LOCAL SESSION</em>
          <span>API bridge</span><em>CLOUDFLARE</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""} ${!isMobile && inspectorCollapsed ? "panelCollapsed" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><div className="panelHeadActions"><button className="panelCollapse" type="button" aria-expanded={!inspectorCollapsed} onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? "‹" : "›"}</button><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div></div>
        {selected
          ? <Inspector entity={selected} onFocus={focusSelected} onStreet={openStreet} onAnnotate={addAnnotation} onClear={clearSelection} followAircraft={followAircraft} onToggleFollow={() => setFollowAircraft((v) => !v)} />
          : <div className="emptyState"><div className="reticle">+</div><p>Street View opens at the current focus/view center. Click the map only when you want to refine the target.</p><div className="emptyActions"><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level here</button><button className="annotationButton" onClick={addAnnotation} disabled={viewMode !== "earth"}>Mark this location</button></div></div>}
      </section>

      <section className={`timebar glass ${viewMode === "space" ? "spaceTimebar" : ""} ${mobilePanel === "time" ? "mobileOpen" : ""} ${!isMobile && timeCollapsed ? "panelCollapsed" : ""}`}>
        <button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button>
        <div className="timebarLead">
          <button className="panelCollapse timebarCollapse" type="button" aria-expanded={!timeCollapsed} onClick={() => setTimeCollapsed((value) => !value)}>{timeCollapsed ? "TIME ›" : "‹"}</button>
          <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        </div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(e) => { setTimeOffsetDays(Number(e.target.value)); setSpacePlaybackDays(0); }} />
        <div className="timeActions">
          <span>{(timeOffsetDays + spacePlaybackDays) > 0 ? `+${(timeOffsetDays + spacePlaybackDays).toFixed(spacePlaybackDays ? 1 : 0)}` : (timeOffsetDays + spacePlaybackDays).toFixed(spacePlaybackDays ? 1 : 0)} days</span>
          {viewMode === "space" && <div className="spaceTimePlayback" role="group" aria-label="Space time playback">
            <button className={spacePlaying ? "active" : ""} onClick={() => setSpacePlaying((playing) => !playing)}>{spacePlaying ? "PAUSE" : "PLAY 1D/S"}</button>
            {[1, 7, 30].map((days) => <button key={days} onClick={() => { setSpacePlaying(false); setSpacePlaybackDays((current) => current + days); }}>+{days}D</button>)}
          </div>}
          <button onClick={resetTime}>NOW</button>
        </div>
      </section>

      {!streetOpen && issPreview && <IssLiveHoverCard entity={issPreview.entity} screen={issPreview.screen} onClose={() => setIssPreview(null)} />}

      {streetOpen && <StreetViewer
        provider={streetProvider} googleApiKey={GOOGLE_MAPS_API_KEY} notice={streetNotice}
        state={streetState} photo={currentStreet} index={streetIndex} total={streetPhotos.length}
        error={layerErrors.street} point={streetPoint} onClose={closeStreet}
        onGoogleReady={handleGoogleStreetReady} onGoogleFallback={handleGoogleStreetFallback}
        onGooglePositionChange={handleGoogleStreetPosition}
        onEarth={() => { closeStreet(); flyEarth(); }}
        onGround={() => { closeStreet(); flyGround(); }}
        onSpace={() => { closeStreet(); window.setTimeout(() => enterSpaceFromEarth(), 0); }}
        onUseGoogle={openStreet}
        onUseKartaView={() => loadKartaViewStreet()}
        onPrevious={() => setStreetIndex((i) => Math.max(0, i - 1))}
        onNext={() => setStreetIndex((i) => Math.min(streetPhotos.length - 1, i + 1))}
      />}

      <nav className="mobileDock glass" aria-label="Mobile controls">
        <button className={mobilePanel === "layers" ? "active" : ""} onClick={() => togglePanel("layers")}>Layers</button>
        <button className={mobilePanel === "inspector" ? "active" : ""} onClick={() => togglePanel("inspector")}>Inspect</button>
        <button className={mobilePanel === "street" ? "active" : ""} onClick={openStreet} disabled={viewMode !== "earth"}>Street</button>
        <button className={mobilePanel === "time" ? "active" : ""} onClick={() => togglePanel("time")}>Time</button>
      </nav>

      {frameHandoff && <div className={`frameHandoff ${frameHandoff}`} aria-live="polite">
        <div className="frameHandoffCore">
          <span>{frameHandoff === "earth-to-space" ? "EARTH → ORBIT" : "ORBIT → EARTH"}</span>
          <strong>{frameHandoff === "earth-to-space" ? "Camera handoff to space frame" : "Restoring Earth camera"}</strong>
        </div>
      </div>}

      <footer className="legend glass">
        <span><i className="legendDot observed" /> OBSERVED</span><span><i className="legendDot calculated" /> CALCULATED</span>
        <span>{viewMode === "earth" && cameraHeight >= 12_000_000 ? "EARTH · DEEP ZOOM · physical planet distance + size" : "Earth · Ground · Orbit · Solar System"}</span><span>ws-pv · GEV-derived core lifecycle · independent live sources</span>
      </footer>
    </main>
  );
}

function LayerToggle({ checked, onChange, onRetry, title, subtitle, state, count, disabled = false, error }: { checked: boolean; onChange: (v: boolean) => void; onRetry: () => void; title: string; subtitle: string; state: LoadState; count?: number; disabled?: boolean; error?: string }) {
  const effectiveState: LoadState | "off" = checked ? state : "off";
  const statusText = effectiveState === "off" ? "Off"
    : effectiveState === "loading" ? "Loading…"
    : effectiveState === "ready" ? (count ? `Live · ${count}` : "Live")
    : effectiveState === "degraded" ? (count ? `Degraded · ${count}` : "Degraded")
    : effectiveState === "error" ? "Unavailable" : "Ready to load";
  return <div className={`layerCard ${disabled ? "disabled" : ""} ${effectiveState === "error" ? "layerError" : ""} ${effectiveState === "degraded" ? "layerDegraded" : ""}`}>
    <label className="layerRow">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><strong>{title}</strong><small>{subtitle}</small></span><b>{checked && count ? count : ""}</b>
    </label>
    <div className={`layerLoadBar state-${effectiveState}`} aria-label={`${title} ${statusText}`}>
      <i />
    </div>
    <div className="layerStatusLine">
      <span>{statusText}</span>
      {effectiveState === "loading" && <small>Fetching layer data…</small>}
      {effectiveState === "ready" && <small>Active with other loaded layers</small>}
      {effectiveState === "degraded" && <small>{error ?? "Keeping last valid data"}</small>}
      {effectiveState === "off" && <small>Tap to load</small>}
      {effectiveState === "error" && <><small>{error ? "Live source unavailable" : "Load failed"}</small><button type="button" onClick={onRetry}>Retry</button></>}
    </div>
  </div>;
}

function Inspector({ entity, onFocus, onStreet, onAnnotate, onClear, followAircraft, onToggleFollow }: { entity: SpatialEntity; onFocus: () => void; onStreet: () => void; onAnnotate: () => void; onClear: () => void; followAircraft: boolean; onToggleFollow: () => void }) {
  const rows: Array<[string, string]> = [];
  if (entity.kind === "earthquake") rows.push(["Magnitude", String(entity.properties.magnitude ?? "—")], ["Depth", `${entity.properties.depthKm ?? "—"} km`]);
  else if (entity.kind === "satellite") rows.push(["NORAD", String(entity.properties.noradCatalogNumber ?? "—")], ["Altitude", `${entity.properties.altitudeKm ?? "—"} km`], ["Propagation", String(entity.properties.propagation ?? "—")]);
  else if (entity.kind === "aircraft") {
    const origin = entity.properties.originAirport ?? entity.properties.origin;
    const destination = entity.properties.destinationAirport ?? entity.properties.destination;
    rows.push(
      ["Callsign", entity.name],
      ["ICAO24", String(entity.properties.hex ?? "—").toUpperCase()],
      ["Provider", String(entity.properties.provider ?? "—")],
      ["Coverage", String(entity.properties.coverage ?? "—")],
      ["Class", String(entity.properties.aircraftClass ?? "—")],
      ["Military", entity.properties.military ? "YES" : "NO"],
      ["Registration", String(entity.properties.registration ?? "—")],
      ["Type", String(entity.properties.aircraftType ?? "—")],
      ["Route", origin && destination ? `${origin} → ${destination}` : "Not available from current ADS-B source"],
      ["Altitude", `${entity.properties.altitudeFt ?? "—"} ft`],
      ["Speed", `${entity.properties.groundSpeedKt ?? "—"} kt`],
      ["Track", `${entity.properties.trackDeg ?? "—"}°`],
      ["Squawk", String(entity.properties.squawk ?? "—")],
      ["Emergency", String(entity.properties.emergency ?? "none")],
      ["Last seen", entity.properties.seenSeconds != null ? `${entity.properties.seenSeconds}s ago` : "—"],
      ["Position", String(entity.properties.displayPosition ?? "last observed ADS-B sample")],
    );
  } else if (entity.kind === "natural-event") {
    rows.push(
      ["Event status", "OPEN EVENT"],
      ["Category", String(entity.properties.categoryTitle ?? entity.properties.category ?? "—")],
      ["Magnitude", entity.properties.magnitude != null ? `${entity.properties.magnitude} ${entity.properties.magnitudeUnit ?? ""}`.trim() : "—"],
    );
  } else if (entity.kind === "aurora") {
    rows.push(["Probability", `${Math.round(Number(entity.properties.probability ?? 0))}%`], ["Kp", String(entity.properties.kp ?? "—")]);
  } else if (entity.kind === "weather-observation") {
    rows.push(
      ["Temperature", `${entity.properties.temperatureC ?? "—"} °C`],
      ["Wind", `${entity.properties.windKmh ?? "—"} km/h`],
      ["Cloud", `${entity.properties.cloudCoverPct ?? "—"}%`],
      ["Visibility", `${entity.properties.visibilityM ?? "—"} m`],
    );
  } else if (entity.kind === "radio-station") {
    rows.push(
      ["Country", String(entity.properties.country ?? "—")],
      ["Language", String(entity.properties.language ?? "—")],
      ["Codec", String(entity.properties.codec ?? "—")],
      ["Bitrate", `${entity.properties.bitrate ?? "—"} kbps`],
    );
  } else if (entity.kind === "infrastructure") {
    rows.push(
      ["Type", String(entity.properties.category ?? "—").replace("-", " ").toUpperCase()],
      ["Operator", String(entity.properties.operator || "Not mapped")],
    );
  } else if (entity.kind === "celestial-body") {
    if (entity.properties.category) rows.push(["Category", String(entity.properties.category)]);
    if (entity.properties.parentBody) rows.push(["Parent", String(entity.properties.parentBody)]);
    if (entity.properties.heliocentricDistanceAu != null) rows.push(["Distance", `${entity.properties.heliocentricDistanceAu} AU`]);
    if (entity.properties.radiusKm != null) rows.push(["Radius", `${entity.properties.radiusKm} km`]);
    if (entity.properties.orbitalRadiusKm != null) rows.push(["Orbit radius", `${Number(entity.properties.orbitalRadiusKm).toLocaleString()} km`]);
    if (entity.properties.orbitalPeriodDays != null) rows.push(["Orbit period", `${entity.properties.orbitalPeriodDays} days`]);
    if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]);
  }
  rows.push([
    entity.kind === "natural-event" ? "Event time" : "Time",
    new Date(entity.observedAt).toLocaleString(),
  ]);
  if (entity.kind !== "natural-event") rows.push(["State", entity.dataState]);
  rows.push(["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2><button className="clearSelectionButton" onClick={onClear}>CLEAR</button></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind === "radio-station" && typeof entity.properties.streamUrl === "string" && <div className="radioPlayer">
    <audio controls preload="none" src={String(entity.properties.streamUrl)} />
    <small>Live stream · playback availability depends on the station</small>
  </div>}{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button>{entity.kind === "aircraft" && <button className="followButton" onClick={onToggleFollow}>{followAircraft ? "Stop follow" : "Follow aircraft"}</button>}<button className="streetButton" onClick={onStreet}>Street near entity</button><button className="annotationButton" onClick={onAnnotate}>Mark location</button></div>}</>;
}

function IssLiveHoverCard({ entity, screen, onClose }: { entity: SpatialEntity; screen: { x: number; y: number } | null; onClose: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const timer = window.setTimeout(() => setReady(true), 500);
    return () => window.clearTimeout(timer);
  }, [entity.id]);
  void screen;
  return <aside className="issLiveHover glass issLivePinned" aria-label="ISS live video preview">
    <div className="issLiveHead"><span><b>ISS · LIVE 4K</b><small>Sen SpaceTV-1 · interactive preview</small></span><div className="issLiveHeadActions"><em>LIVE</em><button type="button" onClick={onClose}>×</button></div></div>
    <div className="issLiveFrame">
      {ready ? <iframe
        src={`https://www.youtube-nocookie.com/embed/${SEN_ISS_LIVE_VIDEO_ID}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`}
        title="Sen live 4K video from the ISS"
        allow="autoplay; encrypted-media; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      /> : <div className="issLiveLoading">Opening ISS live video…</div>}
    </div>
    <div className="issLiveCaveat">Live camera may be dark on Earth's night side or during ISS signal loss.</div>
    <div className="issLiveMeta"><span>{entity.name}</span><a href="https://www.sen.com/live" target="_blank" rel="noreferrer">Open Sen live ↗</a></div>
  </aside>;
}

function StreetViewer({ provider, googleApiKey, notice, state, photo, index, total, error, point, onClose, onEarth, onGround, onSpace, onPrevious, onNext, onUseGoogle, onUseKartaView, onGoogleReady, onGoogleFallback, onGooglePositionChange }: { provider: StreetProvider; googleApiKey: string; notice: string | null; state: LoadState; photo: StreetPhoto | null; index: number; total: number; error?: string; point: EarthPoint; onClose: () => void; onEarth: () => void; onGround: () => void; onSpace: () => void; onPrevious: () => void; onNext: () => void; onUseGoogle: () => void; onUseKartaView: () => void; onGoogleReady: () => void; onGoogleFallback: (message: string) => void; onGooglePositionChange: (point: EarthPoint) => void }) {
  const surfaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);

  return <aside
    ref={surfaceRef}
    className="streetSurface glass"
    role="dialog"
    aria-modal="false"
    aria-label="Street-level imagery"
    tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }}
  >
    <div className="streetSurfaceHead">
      <div><p className="panelLabel">GROUND / STREET</p><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong></div>
      <button className="streetSurfaceClose" type="button" onClick={onClose} aria-label="Close Street View">×</button>
    </div>

    <div className="streetSurfaceTabs" role="tablist" aria-label="Street imagery provider">
      <button type="button" role="tab" aria-selected={provider === "google"} className={provider === "google" ? "active" : ""} disabled={!googleApiKey} onClick={onUseGoogle}>
        Google Street View{!googleApiKey ? " · not configured" : ""}
      </button>
      <button type="button" role="tab" aria-selected={provider === "kartaview"} className={provider === "kartaview" ? "active" : ""} onClick={onUseKartaView}>
        KartaView
      </button>
    </div>

    {notice && <div className="streetSurfaceNotice" role="status">{notice}</div>}

    <div className="streetSurfaceFrame">
      {provider === "google"
        ? state === "error"
          ? <div className="streetMessage"><strong>GOOGLE STREET VIEW UNAVAILABLE</strong><span>{error ?? notice ?? "Google Street View could not be loaded."}</span></div>
          : <GoogleStreetPanorama apiKey={googleApiKey} point={point} onReady={onGoogleReady} onFallback={onGoogleFallback} onPositionChange={onGooglePositionChange} />
        : <>
            {state === "loading" && <div className="streetMessage">Searching KartaView imagery…</div>}
            {state !== "loading" && !photo && <div className="streetMessage"><strong>NO IMAGERY</strong><span>{error ?? notice ?? "No KartaView imagery is available near this point."}</span></div>}
            {photo && <div className="streetImage" role="img" aria-label="KartaView street-level photo" style={{ backgroundImage: `url("${photo.imageUrl.replace(/"/g, "%22")}")` }} />}
          </>}
    </div>

    <div className="streetSurfaceFooter">
      <div className="streetSurfaceNav">
        <button type="button" onClick={onEarth}>EARTH / SAT</button>
        <button type="button" onClick={onGround}>GROUND / MAP</button>
        <button type="button" onClick={onSpace}>SPACE</button>
      </div>
      {provider === "kartaview"
        ? <div className="streetSurfacePager">
            <button type="button" onClick={onPrevious} disabled={index <= 0}>←</button>
            <span>{total ? `${index + 1} / ${total}` : "No imagery"}</span>
            <button type="button" onClick={onNext} disabled={!total || index >= total - 1}>→</button>
          </div>
        : <div className="streetSurfaceSourceRow">
            <span className="streetSurfaceSource">Interactive 360° · Google Street View</span>
          </div>}
    </div>
  </aside>;
}

function GoogleStreetPanorama({ apiKey, point, onReady, onFallback, onPositionChange }: { apiKey: string; point: EarthPoint; onReady: () => void; onFallback: (message: string) => void; onPositionChange: (point: EarthPoint) => void }) {
  const panoRef = useRef<HTMLDivElement | null>(null);
  const initialPointRef = useRef<EarthPoint>(point);

  useEffect(() => {
    let disposed = false;
    let panorama: any = null;
    let positionListener: any = null;
    let statusListener: any = null;
    let watchdog: number | undefined;
    let removeAuthFailureListener: (() => void) | null = null;
    let failed = false;

    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      if (watchdog != null) window.clearTimeout(watchdog);
      removeAuthFailureListener?.();
      onFallback(message);
    };

    if (!apiKey) {
      fail("Google Street View is not configured for this preview");
      return;
    }

    removeAuthFailureListener = onGoogleMapsAuthFailure((message) => {
      fail(message);
    });

    watchdog = window.setTimeout(() => {
      fail("Google Street View did not become ready within 15 seconds");
    }, 15_000);

    const origin = initialPointRef.current;
    Promise.all([
      loadGoogleStreetView(apiKey),
      findGoogleStreetCoverage(apiKey, origin, 120),
    ])
      .then(([streetView, coverage]) => {
        if (disposed || !panoRef.current) return;
        if (!coverage) {
          fail("No Google Street View coverage near the current focus");
          return;
        }

        const { StreetViewPanorama, StreetViewStatus } = streetView;
        panoRef.current.replaceChildren();
        panorama = new StreetViewPanorama(panoRef.current, {
          pano: coverage.panoId,
          position: { lat: coverage.latitude, lng: coverage.longitude },
          pov: { heading: 0, pitch: 0 },
          zoom: 1,
          addressControl: true,
          fullscreenControl: !window.matchMedia("(max-width: 780px)").matches,
          motionTracking: false,
          linksControl: true,
          panControl: true,
          zoomControl: true,
          visible: true,
        });

        const publishPosition = () => {
          const current = panorama?.getPosition?.();
          const latitude = typeof current?.lat === "function" ? current.lat() : NaN;
          const longitude = typeof current?.lng === "function" ? current.lng() : NaN;
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            onPositionChange({ latitude, longitude });
          }
        };

        const markReady = () => {
          if (disposed) return;
          if (watchdog != null) window.clearTimeout(watchdog);
          publishPosition();
          onReady();
        };

        positionListener = panorama.addListener?.("position_changed", publishPosition);
        statusListener = panorama.addListener?.("status_changed", () => {
          const status = panorama?.getStatus?.();
          if (status === StreetViewStatus?.OK || status === "OK") markReady();
          else if (status != null) fail(`Google Street View render status: ${String(status)}`);
        });
        const currentStatus = panorama?.getStatus?.();
        if (currentStatus === StreetViewStatus?.OK || currentStatus === "OK") markReady();
      })
      .catch((error: unknown) => {
        fail(`Google Street View failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      if (watchdog != null) window.clearTimeout(watchdog);
      removeAuthFailureListener?.();
      if (positionListener?.remove) positionListener.remove();
      if (statusListener?.remove) statusListener.remove();
      panorama?.setVisible?.(false);
      panorama = null;
      if (panoRef.current) panoRef.current.replaceChildren();
    };
  }, [apiKey, onReady, onFallback, onPositionChange]);

  return <div ref={panoRef} className="googleStreetPano"><div className="streetMessage">Loading Google Street View…</div></div>;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000, center = size / 2, maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => { const orbitRadius = radiusForAu(p.radiusAu); const angle = Math.atan2(p.yAu, p.xAu); return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
