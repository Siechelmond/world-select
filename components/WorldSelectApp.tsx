"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { createCoreLiveWorld } from "@/runtime/gev/core-live-world";
import { createEarthquakeRenderer } from "@/runtime/gev/layers/earthquakes-renderer";
import { createSatelliteRenderer } from "@/runtime/gev/layers/satellites-renderer";
import { createAircraftRenderer } from "@/runtime/gev/layers/aircraft-renderer";
import { createTrafficController } from "@/runtime/gev/layers/traffic-controller";
import { createCelestialBridgeRenderer } from "@/runtime/gev/layers/celestial-bridge-renderer";
import { propagateTles, type SatelliteCatalog, type TleRecord } from "@/lib/celestrak";
import type { AircraftFeedMeta } from "@/lib/aircraft";
import type { MilitaryFeedMeta } from "@/lib/military";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import SpaceExplorer from "@/components/SpaceExplorer";
import { createWorldViewer, type WorldMapMode } from "@/lib/cesium-viewer";
import { GEO_LABELS_DE } from "@/lib/geo-labels";
import { resolveLayerState, type LayerLoadState as LoadState } from "@/lib/layer-runtime";

declare global { interface Window { Cesium?: any; google?: any; __worldSelectGoogleMapsPromise?: Promise<any>; gm_authFailure?: () => void } }

type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type StreetProvider = "google" | "kartaview";
type EarthPoint = { latitude: number; longitude: number };
type LayerError = { earthquakes?: string; satellites?: string; aircraft?: string; military?: string; street?: string; traffic?: string };

const DAY_MS = 86_400_000;
const SATELLITE_TICK_MS = 1_000;
const MOBILE_SATELLITE_TICK_MS = 2_000;
const AIRCRAFT_REFRESH_MS = 15_000;
const GROUND_HEIGHT_M = 120_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
const SEN_ISS_LIVE_VIDEO_ID = process.env.NEXT_PUBLIC_SEN_ISS_LIVE_VIDEO_ID ?? "fO9e9jnhYK8";
export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  const coreRuntimeRef = useRef<ReturnType<typeof createCoreLiveWorld> | null>(null);

  const [cesiumReady, setCesiumReady] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [tleRecords, setTleRecords] = useState<TleRecord[]>([]);
  const [aircraft, setAircraft] = useState<SpatialEntity[]>([]);
  const [military, setMilitary] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(true);
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [satelliteCatalog, setSatelliteCatalog] = useState<SatelliteCatalog>("core");
  const [aircraftLayer, setAircraftLayer] = useState(true);
  const [militaryLayer, setMilitaryLayer] = useState(true);
  const [trafficLayer, setTrafficLayer] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [earthquakeState, setEarthquakeState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [aircraftState, setAircraftState] = useState<LoadState>("idle");
  const [aircraftMeta, setAircraftMeta] = useState<AircraftFeedMeta | null>(null);
  const [militaryState, setMilitaryState] = useState<LoadState>("idle");
  const [militaryMeta, setMilitaryMeta] = useState<MilitaryFeedMeta | null>(null);
  const [trafficState, setTrafficState] = useState<LoadState>("idle");
  const [trafficVehicleCount, setTrafficVehicleCount] = useState(0);
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
  const [photorealistic3D, setPhotorealistic3D] = useState(false);
  const [threeDError, setThreeDError] = useState<string | null>(null);
  const [earthHandoff, setEarthHandoff] = useState<{ latitude: number; longitude: number; height: number } | null>(null);
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
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);
  const aircraftAvailable = viewMode === "earth" && timeOffsetDays === 0;
  const visibleAircraft = useMemo(() => [
    ...(aircraftLayer ? aircraft : []),
    ...(militaryLayer ? military : []),
  ], [aircraftLayer, aircraft, militaryLayer, military]);
  const renderedAircraft = useMemo(() => {
    const budget = cameraHeight > 2_000_000 ? 180 : cameraHeight > 500_000 ? 260 : 420;
    return [...visibleAircraft]
      .sort((a, b) => {
        const da = (a.position.latitude - viewCenter.latitude) ** 2 + (a.position.longitude - viewCenter.longitude) ** 2;
        const db = (b.position.latitude - viewCenter.latitude) ** 2 + (b.position.longitude - viewCenter.longitude) ** 2;
        return da - db;
      })
      .slice(0, budget);
  }, [visibleAircraft, cameraHeight, viewCenter.latitude, viewCenter.longitude]);
  const aircraftQueryCenter = useMemo(() => {
    const step = cameraHeight < 300_000 ? 0.05 : cameraHeight < 2_000_000 ? 0.15 : 0.35;
    return {
      latitude: Math.round(viewCenter.latitude / step) * step,
      longitude: Math.round(viewCenter.longitude / step) * step,
    };
  }, [viewCenter.latitude, viewCenter.longitude, cameraHeight]);
  const aircraftRadiusNm = cameraHeight < 120_000 ? 70 : cameraHeight < 1_000_000 ? 130 : 220;
  const animateAircraft = cameraHeight < 900_000;
  const streetPoint = streetTarget ?? (
    selected && selected.kind !== "celestial-body"
      ? { latitude: selected.position.latitude, longitude: selected.position.longitude }
      : viewCenter
  );

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

  useEffect(() => {
    if ((!satelliteLayer && !((aircraftLayer || militaryLayer) && animateAircraft)) || timeOffsetDays !== 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), isMobile ? MOBILE_SATELLITE_TICK_MS : SATELLITE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [satelliteLayer, aircraftLayer, militaryLayer, animateAircraft, timeOffsetDays, isMobile]);

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

    runtime.start();
    return () => {
      unsubscribe();
      runtime.destroy();
      if (coreRuntimeRef.current === runtime) coreRuntimeRef.current = null;
    };
  }, [setLayerError]);

  useEffect(() => {
    coreRuntimeRef.current?.setAircraftContext({
      latitude: aircraftQueryCenter.latitude,
      longitude: aircraftQueryCenter.longitude,
      radiusNm: aircraftRadiusNm,
    });
  }, [aircraftQueryCenter.latitude, aircraftQueryCenter.longitude, aircraftRadiusNm]);

  useEffect(() => {
    coreRuntimeRef.current?.setSatelliteCatalog(satelliteCatalog);
  }, [satelliteCatalog]);



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
          setStreetTarget(point);
          setStreetNotice(`Street target set · ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`);
        }
      },
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
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

    return () => {
      earthquakeRendererRef.current?.destroy();
      satelliteRendererRef.current?.destroy();
      aircraftRendererRef.current?.destroy();
      trafficControllerRef.current?.destroy();
      celestialBridgeRendererRef.current?.destroy();
      earthquakeRendererRef.current = null;
      satelliteRendererRef.current = null;
      aircraftRendererRef.current = null;
      trafficControllerRef.current = null;
      celestialBridgeRendererRef.current = null;
      lifecycle.destroy();
      viewerLifecycleRef.current = null;
      viewerRef.current = null;
    };
  }, [cesiumReady, selectEntity]);

  useEffect(() => {
    if (viewMode !== "earth") return;
    viewerLifecycleRef.current?.setMapStyle(cameraHeight < 350_000 ? "ground" : "earth");
    viewerLifecycleRef.current?.setMapMode(mapMode);
  }, [cameraHeight, viewMode, mapMode]);

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

  const switchMapMode = useCallback((mode: WorldMapMode) => {
    setMapMode(mode);
    setThreeDError(null);
    if (photorealistic3D) {
      void viewerLifecycleRef.current?.setPhotorealistic3D(false);
      setPhotorealistic3D(false);
    }
    viewerLifecycleRef.current?.setMapMode(mode);
  }, [photorealistic3D]);

  const toggle3D = useCallback(async () => {
    if (!GOOGLE_MAPS_API_KEY) {
      setThreeDError("Google Maps key is not configured for this preview");
      return;
    }

    const lifecycle = viewerLifecycleRef.current;
    if (!lifecycle) {
      setThreeDError("3D viewer is not ready yet");
      return;
    }

    setStreetOpen(false);
    setThreeDError(null);

    const next = !photorealistic3D;
    const ok = await lifecycle.setPhotorealistic3D(next);
    if (!ok) {
      setPhotorealistic3D(false);
      setThreeDError("Google Photorealistic 3D Tiles could not be loaded. Check the Google Map Tiles API key, billing and referrer restrictions.");
      return;
    }

    setPhotorealistic3D(next);
  }, [photorealistic3D]);



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
      visible: viewMode === "earth" && satelliteLayer,
      selectedId: selected?.kind === "satellite" ? selected.id : null,
      isMobile,
      cameraHeight,
      time: selectedTime,
    });
  }, [satellites, tleRecords, satelliteLayer, viewMode, cesiumReady, isMobile, cameraHeight, selected?.id, selected?.kind, selectedTime]);



  useEffect(() => {
    aircraftRendererRef.current?.sync({
      items: renderedAircraft,
      visible: viewMode === "earth" && (aircraftLayer || militaryLayer) && aircraftAvailable,
      selectedId: selected?.kind === "aircraft" ? selected.id : null,
      followSelected: followAircraft,
      nowMs: nowTick,
      cameraHeight,
    });
  }, [renderedAircraft, aircraftLayer, militaryLayer, aircraftAvailable, viewMode, cesiumReady, nowTick, cameraHeight, selected?.id, selected?.kind, followAircraft]);

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
      visible: viewMode === "earth",
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
    });
  }, [trafficLayer, viewMode, viewCenter.latitude, viewCenter.longitude, cameraHeight, cesiumReady]);


  useEffect(() => {
    if (viewMode === "earth") return;
    earthquakeRendererRef.current?.clear();
    satelliteRendererRef.current?.clear();
    aircraftRendererRef.current?.clear();
  }, [viewMode]);



  const enterSpaceFromEarth = useCallback(() => {
    if (viewMode !== "earth" || streetOpen || photorealistic3D) return;
    setEarthHandoff({
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
      height: cameraHeight,
    });
    setFrameHandoff("earth-to-space");
    setFollowAircraft(false);
    setSelected(null);
    setMobilePanel("none");
    setViewMode("space");
    window.setTimeout(() => setFrameHandoff(null), 520);
  }, [viewMode, streetOpen, photorealistic3D, viewCenter.latitude, viewCenter.longitude, cameraHeight]);

  const returnToEarthFromSpace = useCallback(() => {
    const handoff = earthHandoff ?? {
      latitude: viewCenter.latitude,
      longitude: viewCenter.longitude,
      height: 6_500_000,
    };
    setFrameHandoff("space-to-earth");
    setViewMode("earth");
    setFollowAircraft(false);
    setSelected(null);
    setMapMode("satellite");
    viewerLifecycleRef.current?.setMapStyle("earth");
    viewerLifecycleRef.current?.setMapMode("satellite");

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
  }, [earthHandoff, viewCenter.latitude, viewCenter.longitude]);

  const flyEarth = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false); setSelected(null); setMapMode("satellite");
    viewerLifecycleRef.current?.setMapStyle("earth");
    viewerLifecycleRef.current?.setMapMode("satellite");
    viewerRef.current.camera.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(viewCenter.longitude, viewCenter.latitude, 6_500_000), duration: 1.0 });
  }, [viewCenter.latitude, viewCenter.longitude]);

  const flyGround = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false); setSelected(null); setMapMode("map");
    viewerLifecycleRef.current?.setMapStyle("ground");
    viewerLifecycleRef.current?.setMapMode("map");
    viewerRef.current.camera.flyTo({
      destination: window.Cesium.Cartesian3.fromDegrees(viewCenter.longitude, viewCenter.latitude, 18_000),
      orientation: { heading: 0, pitch: window.Cesium.Math.toRadians(-48), roll: 0 }, duration: 1.2,
    });
  }, [viewCenter.latitude, viewCenter.longitude]);

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
    setStreetProvider("kartaview");
    setStreetState("loading");
    setStreetIndex(0);
    setStreetPhotos([]);
    setStreetNotice(fallbackReason ?? "Searching KartaView nearby imagery…");
    setLayerError("street", fallbackReason);
    const controller = new AbortController();
    fetchStreetPhotos(streetPoint.latitude, streetPoint.longitude, controller.signal)
      .then((photos) => {
        setStreetPhotos(photos);
        setStreetState(photos.length ? "ready" : "error");
        setStreetNotice(photos.length
          ? `KartaView · ${photos.length} nearby image${photos.length === 1 ? "" : "s"}`
          : "No KartaView imagery found near this point");
        setLayerError("street", photos.length ? undefined : "No KartaView coverage near this point");
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : "Street imagery error";
        setStreetState("error");
        setStreetNotice(message);
        setLayerError("street", message);
      });
  }, [streetPoint.latitude, streetPoint.longitude, setLayerError]);

  const openStreet = useCallback(() => {
    if (viewMode !== "earth") return;
    setPhotorealistic3D(false);
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
      loadKartaViewStreet("Google Street View is not configured · using KartaView fallback");
    }
  }, [viewMode, loadKartaViewStreet, setLayerError, streetPoint.latitude, streetPoint.longitude]);

  const handleGoogleStreetReady = useCallback(() => {
    setStreetState("ready");
    setStreetNotice("Google Street View · interactive panorama");
    setLayerError("street");
  }, [setLayerError]);

  const handleGoogleStreetFallback = useCallback((message: string) => {
    loadKartaViewStreet(message);
  }, [loadKartaViewStreet]);

  const handleGoogleStreetPosition = useCallback((point: EarthPoint) => {
    setStreetTarget(point);
  }, []);

  const closeStreet = useCallback(() => {
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

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""} ${!isMobile && layersCollapsed ? "panelCollapsed" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><div className="panelHeadActions"><button className="panelCollapse" type="button" aria-expanded={!layersCollapsed} onClick={() => setLayersCollapsed((value) => !value)}>{layersCollapsed ? "›" : "‹"}</button><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div></div>
        <div className="basemapSwitch" role="group" aria-label="Basemap mode">
          <button className={!photorealistic3D && mapMode === "satellite" ? "active" : ""} onClick={() => switchMapMode("satellite")}>SAT</button>
          <button className={!photorealistic3D && mapMode === "map" ? "active" : ""} onClick={() => switchMapMode("map")}>MAP</button>
          <button className={!photorealistic3D && mapMode === "nasa" ? "active" : ""} onClick={() => switchMapMode("nasa")}>NASA EO</button>
          <button className={photorealistic3D ? "active" : ""} disabled={!GOOGLE_MAPS_API_KEY} onClick={toggle3D}>3D</button>
        </div>
        {!GOOGLE_MAPS_API_KEY && <div className="mapModeNotice">Google Street View + Photorealistic 3D are not configured on this preview. SAT / MAP / NASA remain available.</div>}
        {threeDError && <div className="mapModeNotice">{threeDError}</div>}
        <LayerToggle checked={earthquakeLayer} onChange={toggleEarthquakeLayer} onRetry={() => retryLayer("earthquakes")} title="Earthquakes" subtitle="USGS · recent M2.5+ events" state={earthquakeState} count={earthquakes.length} disabled={viewMode !== "earth"} error={layerErrors.earthquakes} />
        <LayerToggle checked={satelliteLayer} onChange={toggleSatelliteLayer} onRetry={() => retryLayer("satellites")} title="Satellites" subtitle={`CelesTrak ${satelliteCatalog.toUpperCase()} · SGP4 · real altitude · perspective-scaled`} state={satelliteState} count={satellites.length} disabled={viewMode !== "earth"} error={layerErrors.satellites} />
        <div className="satelliteCatalogSwitch" role="group" aria-label="Satellite catalog">
          <button className={satelliteCatalog === "core" ? "active" : ""} onClick={() => setSatelliteCatalog("core")}>CORE</button>
          <button className={satelliteCatalog === "dense" ? "active" : ""} onClick={() => setSatelliteCatalog("dense")}>DENSE</button>
        </div>
        <LayerToggle checked={aircraftLayer} onChange={toggleAircraftLayer} onRetry={() => retryLayer("aircraft")} title="Aircraft" subtitle={aircraftAvailable ? `ADS-B · ${aircraftMeta?.provider ?? "adsb.lol / OpenSky"} · real altitude · ${renderedAircraft.length}/${visibleAircraft.length} rendered` : "NOW only"} state={aircraftState} count={aircraftAvailable ? renderedAircraft.length : 0} disabled={!aircraftAvailable} error={layerErrors.aircraft} />
        <LayerToggle checked={militaryLayer} onChange={toggleMilitaryLayer} onRetry={() => retryLayer("military")} title="Military" subtitle={aircraftAvailable ? `ADSB.lol · global military snapshot · ${militaryMeta?.stale ? "last-good" : "live"}` : "NOW only"} state={militaryState} count={aircraftAvailable ? military.length : 0} disabled={!aircraftAvailable} error={layerErrors.military} />
        <LayerToggle checked={trafficLayer} onChange={setTrafficLayer} onRetry={() => retryLayer("traffic")} title="Traffic" subtitle="AUTO near ground · OSM roads + modeled vehicles · TomTom when available" state={trafficState} count={trafficVehicleCount} disabled={viewMode !== "earth"} error={layerErrors.traffic} />
        <label className={`layerRow ${viewMode !== "earth" ? "disabled" : ""}`}>
          <input type="checkbox" checked={planetOrbits} disabled={viewMode !== "earth"} onChange={(event) => setPlanetOrbits(event.target.checked)} />
          <span><strong>Planet orbits</strong><small>Approximate JPL elements · physical AU/m scale</small></span>
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
          : <div className="emptyState"><div className="reticle">+</div><p>Click a point on the globe/map to set the Street View target, or select an entity.</p><div className="emptyActions"><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level at target</button><button className="annotationButton" onClick={addAnnotation} disabled={viewMode !== "earth"}>Mark this location</button></div></div>}
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
  } else if (entity.kind === "celestial-body") {
    if (entity.properties.category) rows.push(["Category", String(entity.properties.category)]);
    if (entity.properties.parentBody) rows.push(["Parent", String(entity.properties.parentBody)]);
    if (entity.properties.heliocentricDistanceAu != null) rows.push(["Distance", `${entity.properties.heliocentricDistanceAu} AU`]);
    if (entity.properties.radiusKm != null) rows.push(["Radius", `${entity.properties.radiusKm} km`]);
    if (entity.properties.orbitalRadiusKm != null) rows.push(["Orbit radius", `${Number(entity.properties.orbitalRadiusKm).toLocaleString()} km`]);
    if (entity.properties.orbitalPeriodDays != null) rows.push(["Orbit period", `${entity.properties.orbitalPeriodDays} days`]);
    if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]);
  }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2><button className="clearSelectionButton" onClick={onClear}>CLEAR</button></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button>{entity.kind === "aircraft" && <button className="followButton" onClick={onToggleFollow}>{followAircraft ? "Stop follow" : "Follow aircraft"}</button>}<button className="streetButton" onClick={onStreet}>Street near entity</button><button className="annotationButton" onClick={onAnnotate}>Mark location</button></div>}</>;
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
        ? <GoogleStreetPanorama apiKey={googleApiKey} point={point} onReady={onGoogleReady} onFallback={onGoogleFallback} onPositionChange={onGooglePositionChange} />
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
            <a
              className="streetSurfaceExternal"
              href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open Google Maps ↗
            </a>
          </div>}
    </div>
  </aside>;
}

function GoogleStreetPanorama({ apiKey, point, onReady, onFallback, onPositionChange }: { apiKey: string; point: EarthPoint; onReady: () => void; onFallback: (message: string) => void; onPositionChange: (point: EarthPoint) => void }) {
  const panoRef = useRef<HTMLDivElement | null>(null);
  const initialPointRef = useRef<EarthPoint>(point);

  useEffect(() => {
    let disposed = false;
    let completed = false;
    let panorama: any = null;
    let positionListener: any = null;
    let watchdog: number | undefined;
    const priorAuthFailure = window.gm_authFailure;

    const fail = (message: string) => {
      if (disposed || completed) return;
      completed = true;
      if (watchdog != null) window.clearTimeout(watchdog);
      onFallback(message);
    };

    const authFailure = () => {
      try { priorAuthFailure?.(); } catch {}
      fail("Google Maps authentication failed · using KartaView fallback");
    };

    window.gm_authFailure = authFailure;

    if (!apiKey) {
      fail("Google Street View is not configured · using KartaView fallback");
      return () => {
        if (window.gm_authFailure === authFailure) window.gm_authFailure = priorAuthFailure;
      };
    }

    watchdog = window.setTimeout(() => {
      fail("Google Street View timed out after 12 seconds · using KartaView fallback");
    }, 12_000);

    loadGoogleMaps(apiKey)
      .then((google) => {
        if (disposed || completed || !panoRef.current) return;

        const service = new google.maps.StreetViewService();
        const origin = initialPointRef.current;
        const request = {
          location: { lat: origin.latitude, lng: origin.longitude },
          radius: 120,
        };

        const lookup = new Promise<any>((resolve, reject) => {
          let settled = false;
          const callback = (data: any, status: any) => {
            if (settled) return;
            const ok = status == null || status === "OK" || status === google.maps.StreetViewStatus?.OK;
            settled = true;
            if (ok && data) resolve({ data });
            else reject(new Error(`Google Street View status: ${String(status ?? "UNKNOWN")}`));
          };

          try {
            const maybePromise = service.getPanorama(request, callback);
            if (maybePromise && typeof maybePromise.then === "function") {
              maybePromise.then(
                (value: any) => {
                  if (settled) return;
                  settled = true;
                  resolve(value);
                },
                (reason: unknown) => {
                  if (settled) return;
                  settled = true;
                  reject(reason);
                },
              );
            }
          } catch (reason) {
            if (!settled) {
              settled = true;
              reject(reason);
            }
          }
        });

        return lookup.then(({ data }: any) => {
          if (disposed || completed || !panoRef.current) return;
          const location = data?.location;
          if (!location?.pano) throw new Error("Google Street View returned no panorama data");

          panorama = new google.maps.StreetViewPanorama(panoRef.current, {
            pano: location.pano,
            position: location.latLng,
            pov: { heading: 0, pitch: 0 },
            zoom: 1,
            addressControl: true,
            fullscreenControl: !window.matchMedia("(max-width: 780px)").matches,
            motionTracking: false,
            linksControl: true,
            panControl: true,
            zoomControl: true,
          });

          const publishPosition = () => {
            const current = panorama?.getPosition?.();
            const latitude = typeof current?.lat === "function" ? current.lat() : NaN;
            const longitude = typeof current?.lng === "function" ? current.lng() : NaN;
            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
              onPositionChange({ latitude, longitude });
            }
          };

          publishPosition();
          positionListener = panorama.addListener?.("position_changed", publishPosition);
          completed = true;
          if (watchdog != null) window.clearTimeout(watchdog);
          onReady();
        });
      })
      .catch((error: unknown) => {
        const raw =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : typeof (error as any)?.status === "string"
                ? (error as any).status
                : "Google Street View lookup failed";
        fail(`Google Street View lookup failed: ${raw} · using KartaView fallback`);
      });

    return () => {
      disposed = true;
      if (watchdog != null) window.clearTimeout(watchdog);
      if (positionListener?.remove) positionListener.remove();
      if (window.gm_authFailure === authFailure) window.gm_authFailure = priorAuthFailure;
      panorama = null;
    };
  }, [apiKey, onReady, onFallback, onPositionChange]);

  return <div ref={panoRef} className="googleStreetPano"><div className="streetMessage">Loading Google Street View…</div></div>;
}

function loadGoogleMaps(apiKey: string): Promise<any> {
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;

  window.__worldSelectGoogleMapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
    if (existing) {
      if (window.google?.maps) {
        resolve(window.google);
        return;
      }
      existing.addEventListener("load", () =>
        window.google?.maps
          ? resolve(window.google)
          : reject(new Error("Google Maps loaded without maps library")),
      { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Maps JavaScript API could not be loaded")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&libraries=streetView`;
    script.async = true;
    script.defer = true;
    script.dataset.worldSelectGoogleMaps = "1";
    script.onload = () =>
      window.google?.maps
        ? resolve(window.google)
        : reject(new Error("Google Maps loaded without maps library"));
    script.onerror = () => reject(new Error("Google Maps JavaScript API could not be loaded"));
    document.head.appendChild(script);
  }).catch((reason) => {
    window.__worldSelectGoogleMapsPromise = undefined;
    throw reason;
  });

  return window.__worldSelectGoogleMapsPromise;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000, center = size / 2, maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => { const orbitRadius = radiusForAu(p.radiusAu); const angle = Math.atan2(p.yAu, p.xAu); return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
