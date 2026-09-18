"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { createCoreLiveWorld } from "@/runtime/gev/core-live-world";
import { propagateTles, propagateTleOrbitEcf, type SatelliteCatalog, type TleRecord } from "@/lib/celestrak";
import { projectAircraftPosition, type AircraftFeedMeta } from "@/lib/aircraft";
import type { MilitaryFeedMeta } from "@/lib/military";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import SpaceExplorer from "@/components/SpaceExplorer";
import { createWorldViewer } from "@/lib/cesium-viewer";
import { GEO_LABELS_DE } from "@/lib/geo-labels";
import { fetchTrafficStatus, type TrafficStatus } from "@/lib/traffic";
import {
  advanceModeledVehicles,
  buildModeledFlows,
  fetchRoads,
  generateModeledVehicles,
  getCongestionColor,
  type FlowSegment,
  type ModeledVehicle,
  type RoadSegment,
} from "@/lib/traffic-vector";
import { resolveLayerState, type LayerLoadState as LoadState } from "@/lib/layer-runtime";

declare global { interface Window { Cesium?: any; google?: any; __worldSelectGoogleMapsPromise?: Promise<any> } }

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
const AIRCRAFT_ICON = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="white" stroke="#111827" stroke-width="2" d="M32 3c3 0 5 4 5 9v12l20 12v6L37 36v13l8 7v5l-13-4-13 4v-5l8-7V36L7 42v-6l20-12V12c0-5 2-9 5-9Z"/></svg>`)}`;

export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const entityMapRef = useRef(new Map<string, SpatialEntity>());
  const quakeIdsRef = useRef(new Set<string>());
  const satIdsRef = useRef(new Set<string>());
  const aircraftIdsRef = useRef(new Set<string>());
  const satelliteTrailRef = useRef(new Map<string, any[]>());
  const aircraftTrailRef = useRef(new Map<string, Array<{ longitude: number; latitude: number; altitudeMeters: number }>>());
  const geoLabelIdsRef = useRef(new Set<string>());
  const annotationIdsRef = useRef(new Set<string>());
  const trafficLayerRef = useRef<any>(null);
  const trafficIncidentLayerRef = useRef<any>(null);
  const aircraftCoverageRef = useRef<any>(null);
  const satelliteOrbitRef = useRef<any>(null);
  const viewerLifecycleRef = useRef<ReturnType<typeof createWorldViewer> | null>(null);
  const trafficVehicleCollectionRef = useRef<any>(null);
  const trafficRoadCollectionRef = useRef<any>(null);
  const trafficVectorAbortRef = useRef<AbortController | null>(null);
  const trafficVehicleTimerRef = useRef<number | null>(null);
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
  const [trafficStatus, setTrafficStatus] = useState<TrafficStatus | null>(null);
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
  const [spacePlaybackRate, setSpacePlaybackRate] = useState(7);
  const [spacePlaying, setSpacePlaying] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [layerErrors, setLayerErrors] = useState<LayerError>({});
  const [streetPhotos, setStreetPhotos] = useState<StreetPhoto[]>([]);
  const [streetIndex, setStreetIndex] = useState(0);
  const [streetState, setStreetState] = useState<LoadState>("idle");
  const [streetOpen, setStreetOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Array<{ id: string; latitude: number; longitude: number; label: string }>>([]);
  const [streetProvider, setStreetProvider] = useState<StreetProvider>(GOOGLE_MAPS_API_KEY ? "google" : "kartaview");
  const [reloadNonce, setReloadNonce] = useState({ earthquakes: 0, satellites: 0, aircraft: 0, traffic: 0 });

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
  const streetPoint = selected && selected.kind !== "celestial-body"
    ? { latitude: selected.position.latitude, longitude: selected.position.longitude }
    : viewCenter;

  const setLayerError = useCallback((key: keyof LayerError, message?: string) => {
    setLayerErrors((current) => ({ ...current, [key]: message }));
  }, []);

  const selectEntity = useCallback((entity: SpatialEntity) => {
    setSelected(entity);
    setMobilePanel("inspector");
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
      setSpacePlaybackDays((days) => days + spacePlaybackRate * (tickMs / 1000));
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [viewMode, spacePlaying, spacePlaybackRate]);

  useEffect(() => {
    if (viewMode !== "space" && spacePlaying) setSpacePlaying(false);
  }, [viewMode, spacePlaying]);

  useEffect(() => {
    if (hovered?.kind === "satellite" && /ISS.*ZARYA|^ISS\b/i.test(hovered.name)) {
      setIssPreview({ entity: hovered, screen: hoveredScreen });
    }
  }, [hovered, hoveredScreen]);

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
    if (!trafficLayer || viewMode !== "earth" || cameraHeight >= 180_000) {
      if (trafficLayer && viewMode === "earth") setTrafficState("idle");
      return;
    }
    const controller = new AbortController();
    setTrafficState("loading");
    setLayerError("traffic");
    fetchTrafficStatus(controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return;
        setTrafficStatus(status);
        if (status.configured && status.available) {
          setTrafficState("ready");
          setLayerError("traffic");
        } else {
          setTrafficState("degraded");
          setLayerError("traffic", "Live TomTom flow unavailable · loading OSM road geometry + modeled vehicles");
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setTrafficState("degraded");
        setLayerError("traffic", reason instanceof Error
          ? `${reason.message} · loading OSM road geometry + modeled vehicles`
          : "Live traffic status unavailable · loading OSM road geometry + modeled vehicles");
      });
    return () => controller.abort();
  }, [trafficLayer, viewMode, cameraHeight, reloadNonce.traffic, setLayerError]);

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
    });
    viewerLifecycleRef.current = lifecycle;
    viewerRef.current = lifecycle.viewer;

    return () => {
      lifecycle.destroy();
      viewerLifecycleRef.current = null;
      viewerRef.current = null;
    };
  }, [cesiumReady, selectEntity]);

  useEffect(() => {
    if (viewMode !== "earth") return;
    viewerLifecycleRef.current?.setMapStyle(cameraHeight < 350_000 ? "ground" : "earth");
  }, [cameraHeight, viewMode]);

  const clearIds = useCallback((ids: Set<string>) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const id of ids) { viewer.entities.removeById(id); entityMapRef.current.delete(id); }
    ids.clear();
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    clearIds(quakeIdsRef.current);
    if (viewMode !== "earth" || !earthquakeLayer) return;
    for (const spatial of earthquakes) {
      const magnitude = Number(spatial.properties.magnitude ?? 0);
      entityMapRef.current.set(spatial.id, spatial); quakeIdsRef.current.add(spatial.id);
      viewer.entities.add({
        id: spatial.id,
        position: Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, 0),
        point: {
          pixelSize: Math.max(7, Math.min(20, 5 + magnitude * 2)),
          color: Cesium.Color.fromCssColorString("#fb923c").withAlpha(0.92),
          outlineColor: Cesium.Color.fromCssColorString("#fff7ed"), outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
  }, [earthquakes, earthquakeLayer, viewMode, clearIds, cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    if (viewMode !== "earth" || !satelliteLayer) { clearIds(satIdsRef.current); return; }
    const liveIds = new Set<string>();
    const selectedSatelliteId = selected?.kind === "satellite" ? selected.id : null;
    for (const spatial of satellites) {
      liveIds.add(spatial.id); entityMapRef.current.set(spatial.id, spatial);
      const position = Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, spatial.position.altitudeMeters);
      const existing = viewer.entities.getById(spatial.id);
      const isSelected = spatial.id === selectedSatelliteId;
      const trail = satelliteTrailRef.current.get(spatial.id) ?? [];
      if (isSelected) {
        const last = trail[trail.length - 1];
        const moved = !last || Cesium.Cartesian3.distance(last, position) > 2_000;
        if (moved) trail.push(position);
        const maxTrailPoints = isMobile ? 12 : 36;
        while (trail.length > maxTrailPoints) trail.shift();
        satelliteTrailRef.current.set(spatial.id, trail);
      } else if (trail.length) {
        satelliteTrailRef.current.delete(spatial.id);
      }
      const pixelSize = cameraHeight > 5_000_000 ? 4 : cameraHeight > 1_500_000 ? 6 : 8;
      const trailPositions = isSelected ? [...trail] : [];
      const showLabel = isSelected || spatial.name.includes("ISS") || spatial.name.includes("TIANHE");
      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(position);
        if (existing.point) existing.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
        if (existing.polyline) {
          existing.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
          existing.polyline.positions = new Cesium.ConstantProperty(trailPositions);
        }
        if (existing.label) {
          existing.label.show = new Cesium.ConstantProperty(showLabel);
          existing.label.text = new Cesium.ConstantProperty(showLabel ? spatial.name : "");
        }
      } else {
        satIdsRef.current.add(spatial.id);
        viewer.entities.add({
          id: spatial.id, position,
          point: { pixelSize, color: Cesium.Color.fromCssColorString("#67e8f9"), outlineColor: Cesium.Color.WHITE, outlineWidth: isSelected ? 2 : 0.5 },
          polyline: { show: isSelected && trailPositions.length > 1, positions: trailPositions, width: 1.5, material: Cesium.Color.fromCssColorString("#67e8f9").withAlpha(0.55) },
          label: {
            show: showLabel, text: showLabel ? spatial.name : "",
            font: "11px sans-serif", fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(10, -10),
          },
        });
      }
    }
    for (const id of Array.from(satIdsRef.current) as string[]) {
      if (!liveIds.has(id)) { viewer.entities.removeById(id); entityMapRef.current.delete(id); satIdsRef.current.delete(id); satelliteTrailRef.current.delete(id); }
    }
  }, [satellites, satelliteLayer, viewMode, clearIds, cesiumReady, isMobile, cameraHeight, selected]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    if (satelliteOrbitRef.current) {
      viewer.entities.remove(satelliteOrbitRef.current);
      satelliteOrbitRef.current = null;
    }
    if (viewMode !== "earth" || !satelliteLayer) return;
    const issRecord = tleRecords.find((record) => /ISS.*ZARYA|^ISS\b/i.test(record.name));
    if (!issRecord) return;
    const orbit = propagateTleOrbitEcf(issRecord, new Date(), 180);
    if (orbit.length < 2) return;
    satelliteOrbitRef.current = viewer.entities.add({
      id: "iss-live-orbit",
      polyline: {
        positions: orbit.map((point) => new Cesium.Cartesian3(point.x, point.y, point.z)),
        width: 2.4,
        material: Cesium.Color.fromCssColorString("#67e8f9").withAlpha(0.58),
      },
    });
    return () => {
      if (satelliteOrbitRef.current && viewerRef.current) {
        viewerRef.current.entities.remove(satelliteOrbitRef.current);
        satelliteOrbitRef.current = null;
      }
    };
  }, [tleRecords, satelliteLayer, viewMode, cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;

    if (aircraftCoverageRef.current) {
      viewer.entities.remove(aircraftCoverageRef.current);
      aircraftCoverageRef.current = null;
    }

    if (viewMode !== "earth" || (!aircraftLayer && !militaryLayer) || !aircraftAvailable) {
      clearIds(aircraftIdsRef.current);
      return;
    }

    // Query coverage remains in source metadata; do not paint an ambiguous yellow footprint on the globe.
    const liveIds = new Set<string>();
    const selectedAircraftId = selected?.kind === "aircraft" ? selected.id : null;

    for (const spatial of renderedAircraft) {
      liveIds.add(spatial.id);
      const isSelected = spatial.id === selectedAircraftId;
      const canProject = spatial.dataState !== "STALE" && followAircraft && isSelected;
      const projected = canProject ? projectAircraftPosition(spatial, nowTick) : spatial.position;
      const displayEntity: SpatialEntity = {
        ...spatial,
        position: projected,
        dataState: canProject ? "ESTIMATED" : spatial.dataState,
        properties: {
          ...spatial.properties,
          displayPosition: canProject ? "estimated between observed ADS-B samples" : spatial.dataState === "STALE" ? "last known stale ADS-B sample" : "last observed ADS-B sample",
        },
      };
      entityMapRef.current.set(spatial.id, displayEntity);
      const position = Cesium.Cartesian3.fromDegrees(projected.longitude, projected.latitude, projected.altitudeMeters);
      const existing = viewer.entities.getById(spatial.id);
      const speed = Number(spatial.properties.groundSpeedKt ?? 0);

      // Trails are expensive and visually noisy: only the selected aircraft gets one.
      const observedTrail = isSelected ? (aircraftTrailRef.current.get(spatial.id) ?? []) : [];
      const trailPositions = observedTrail.map((p) => Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.altitudeMeters));
      const pixelSize = cameraHeight > 2_000_000 ? 4 : cameraHeight > 600_000 ? 5 : speed > 250 ? 8 : 7;

      const headingDeg = Number(spatial.properties.trackDeg ?? 0);
      const iconSize = Math.max(14, pixelSize * (isSelected ? 4.1 : 3.2));
      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(position);
        if (existing.billboard) {
          existing.billboard.width = new Cesium.ConstantProperty(iconSize);
          existing.billboard.height = new Cesium.ConstantProperty(iconSize);
          existing.billboard.rotation = new Cesium.ConstantProperty(Cesium.Math.toRadians(-headingDeg));
          existing.billboard.color = new Cesium.ConstantProperty(isSelected ? Cesium.Color.fromCssColorString("#fde047") : Cesium.Color.fromCssColorString("#facc15"));
        }
        if (existing.polyline) {
          existing.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
          existing.polyline.positions = new Cesium.ConstantProperty(trailPositions);
        }
        if (existing.label) {
          existing.label.show = new Cesium.ConstantProperty(isSelected);
          existing.label.text = new Cesium.ConstantProperty(`${spatial.name}`);
        }
      } else {
        aircraftIdsRef.current.add(spatial.id);
        viewer.entities.add({
          id: spatial.id,
          position,
          billboard: {
            image: AIRCRAFT_ICON,
            width: iconSize,
            height: iconSize,
            rotation: Cesium.Math.toRadians(-headingDeg),
            color: isSelected ? Cesium.Color.fromCssColorString("#fde047") : Cesium.Color.fromCssColorString("#facc15"),
            disableDepthTestDistance: 3_000_000,
          },
          polyline: {
            show: isSelected && trailPositions.length > 1,
            positions: trailPositions,
            width: 2,
            material: Cesium.Color.fromCssColorString("#facc15").withAlpha(0.65),
            clampToGround: false,
          },
          label: {
            show: isSelected,
            text: `${spatial.name}`,
            font: "11px sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#fef08a"),
            pixelOffset: new Cesium.Cartesian2(13, -13),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#111827").withAlpha(0.72),
          },
        });
      }
    }

    for (const id of Array.from(aircraftIdsRef.current) as string[]) {
      if (!liveIds.has(id)) {
        viewer.entities.removeById(id);
        entityMapRef.current.delete(id);
        aircraftIdsRef.current.delete(id);
      }
    }

    return () => {
      if (aircraftCoverageRef.current) {
        viewer.entities.remove(aircraftCoverageRef.current);
        aircraftCoverageRef.current = null;
      }
    };
  }, [renderedAircraft, aircraftLayer, militaryLayer, aircraftAvailable, viewMode, clearIds, cesiumReady, nowTick, animateAircraft, cameraHeight, aircraftQueryCenter.latitude, aircraftQueryCenter.longitude, aircraftRadiusNm, selected, followAircraft]);

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
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    if (trafficLayerRef.current) {
      viewer.imageryLayers.remove(trafficLayerRef.current, true);
      trafficLayerRef.current = null;
    }
    if (trafficIncidentLayerRef.current) {
      viewer.imageryLayers.remove(trafficIncidentLayerRef.current, true);
      trafficIncidentLayerRef.current = null;
    }
    if (viewMode !== "earth" || !trafficLayer || !trafficStatus?.configured || !trafficStatus?.available) return;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: "/api/traffic?z={z}&x={x}&y={y}",
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: "Traffic © TomTom",
    });
    const onTileError = (error: any) => {
      setTrafficState("degraded");
      const status = Number(error?.statusCode ?? 0);
      setLayerError("traffic", status ? `Traffic tile request failed (HTTP ${status}) · keeping loaded tiles` : "Traffic tile refresh delayed · keeping loaded tiles");
    };
    provider.errorEvent?.addEventListener(onTileError);
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = 1.0;
    layer.brightness = 1.08;
    layer.contrast = 1.12;
    trafficLayerRef.current = layer;

    const incidentProvider = new Cesium.UrlTemplateImageryProvider({
      url: "/api/traffic?kind=incidents&z={z}&x={x}&y={y}",
      minimumLevel: 0,
      maximumLevel: 20,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: "Traffic incidents © TomTom",
    });
    incidentProvider.errorEvent?.addEventListener(onTileError);
    const incidentLayer = viewer.imageryLayers.addImageryProvider(incidentProvider);
    incidentLayer.alpha = 0.70;
    trafficIncidentLayerRef.current = incidentLayer;

    return () => {
      provider.errorEvent?.removeEventListener(onTileError);
      incidentProvider.errorEvent?.removeEventListener(onTileError);
      if (trafficLayerRef.current && viewerRef.current) {
        viewerRef.current.imageryLayers.remove(trafficLayerRef.current, true);
        trafficLayerRef.current = null;
      }
      if (trafficIncidentLayerRef.current && viewerRef.current) {
        viewerRef.current.imageryLayers.remove(trafficIncidentLayerRef.current, true);
        trafficIncidentLayerRef.current = null;
      }
    };
  }, [trafficLayer, trafficStatus?.configured, trafficStatus?.available, viewMode, cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;

    const clearVector = () => {
      trafficVectorAbortRef.current?.abort();
      trafficVectorAbortRef.current = null;
      if (trafficVehicleTimerRef.current != null) {
        window.clearInterval(trafficVehicleTimerRef.current);
        trafficVehicleTimerRef.current = null;
      }
      if (viewerRef.current && trafficVehicleCollectionRef.current) {
        try { viewerRef.current.scene.primitives.remove(trafficVehicleCollectionRef.current); } catch {}
        trafficVehicleCollectionRef.current = null;
      }
      if (viewerRef.current && trafficRoadCollectionRef.current) {
        try { viewerRef.current.scene.primitives.remove(trafficRoadCollectionRef.current); } catch {}
        trafficRoadCollectionRef.current = null;
      }
      setTrafficVehicleCount(0);
    };

    if (!viewer || !Cesium || !trafficLayer || viewMode !== "earth" || cameraHeight >= 180_000) {
      clearVector();
      return;
    }

    clearVector();
    const controller = new AbortController();
    trafficVectorAbortRef.current = controller;
    setTrafficState("loading");

    let roads: RoadSegment[] = [];
    let flows: FlowSegment[] = [];
    let vehicles: ModeledVehicle[] = [];
    const roadCollection = new Cesium.PolylineCollection();
    const vehicleCollection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(roadCollection);
    viewer.scene.primitives.add(vehicleCollection);
    trafficRoadCollectionRef.current = roadCollection;
    trafficVehicleCollectionRef.current = vehicleCollection;

    const renderVehicles = () => {
      vehicleCollection.removeAll();
      const flowMap = new Map(flows.map((item) => [item.roadId, item]));
      for (const vehicle of vehicles) {
        const flow = flowMap.get(vehicle.roadId);
        vehicleCollection.add({
          position: Cesium.Cartesian3.fromDegrees(vehicle.position.longitude, vehicle.position.latitude, 8),
          pixelSize: cameraHeight < 30_000 ? 4 : 3,
          color: Cesium.Color.fromCssColorString(getCongestionColor(flow?.congestion ?? "free-flow")),
          outlineColor: Cesium.Color.fromCssColorString("#020617"),
          outlineWidth: 1,
          disableDepthTestDistance: 5_000,
        });
      }
      setTrafficVehicleCount(vehicles.length);
      viewer.scene.requestRender?.();
    };

    fetchRoads(viewCenter.latitude, viewCenter.longitude, cameraHeight < 35_000 ? 5 : 8, controller.signal)
      .then((nextRoads) => {
        if (controller.signal.aborted) return;
        roads = nextRoads.slice(0, 500);
        flows = buildModeledFlows(roads);
        vehicles = generateModeledVehicles(roads, flows, 260);
        const flowMap = new Map(flows.map((flow) => [flow.roadId, flow]));
        for (const road of roads) {
          if (road.coordinates.length < 2) continue;
          roadCollection.add({
            positions: road.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 5)),
            width: road.highway === "motorway" || road.highway === "trunk" ? 3 : 2,
            material: Cesium.Material.fromType("Color", {
              color: Cesium.Color.fromCssColorString(getCongestionColor(flowMap.get(road.id)?.congestion ?? "free-flow")).withAlpha(0.82),
            }),
          });
        }
        renderVehicles();
        setTrafficState(roads.length ? (trafficStatus?.available ? "ready" : "degraded") : "error");
        setLayerError("traffic", roads.length
          ? (trafficStatus?.available
              ? "Live TomTom flow available · OSM road geometry + modeled vehicle context"
              : "OSM road geometry + modeled vehicle context · live flow unavailable")
          : "No OSM road geometry returned for this viewport");
        if (vehicles.length) {
          trafficVehicleTimerRef.current = window.setInterval(() => {
            vehicles = advanceModeledVehicles(vehicles, roads, flows, 0.25);
            renderVehicles();
          }, 250);
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setTrafficState("error");
        setLayerError("traffic", reason instanceof Error ? reason.message : "OSM road geometry unavailable");
      });

    return clearVector;
  }, [
    trafficLayer,
    viewMode,
    cameraHeight,
    viewCenter.latitude,
    viewCenter.longitude,
    trafficStatus?.available,
    reloadNonce.traffic,
    setLayerError,
  ]);

  useEffect(() => {
    if (viewMode === "earth") return;
    clearIds(quakeIdsRef.current); clearIds(satIdsRef.current); clearIds(aircraftIdsRef.current);
  }, [viewMode, clearIds]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!followAircraft || selected?.kind !== "aircraft") {
      if (viewer.trackedEntity) viewer.trackedEntity = undefined;
      return;
    }
    const target = viewer.entities.getById(selected.id);
    if (target) viewer.trackedEntity = target;
    return () => { if (viewerRef.current?.trackedEntity?.id === selected.id) viewerRef.current.trackedEntity = undefined; };
  }, [followAircraft, selected?.id, selected?.kind]);

  const flyEarth = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false);
    viewerLifecycleRef.current?.setMapStyle("earth");
    viewerRef.current.camera.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(viewCenter.longitude, viewCenter.latitude, 6_500_000), duration: 1.0 });
  }, [viewCenter.latitude, viewCenter.longitude]);

  const flyGround = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false);
    viewerLifecycleRef.current?.setMapStyle("ground");
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
    setLayerError("street", fallbackReason);
    const controller = new AbortController();
    fetchStreetPhotos(streetPoint.latitude, streetPoint.longitude, controller.signal)
      .then((photos) => {
        setStreetPhotos(photos);
        setStreetState(photos.length ? "ready" : "error");
        if (photos.length) {
          setLayerError("street", fallbackReason ? `${fallbackReason} · KartaView fallback active` : undefined);
        } else {
          const noCoverage = "No KartaView imagery found within the documented 500 m search radius";
          setLayerError("street", fallbackReason ? `${fallbackReason} · ${noCoverage}` : noCoverage);
        }
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : "Street imagery error";
        setStreetState("error");
        setLayerError("street", fallbackReason ? `${fallbackReason} · ${message}` : message);
      });
  }, [streetPoint.latitude, streetPoint.longitude, setLayerError]);

  const openStreet = useCallback(() => {
    if (viewMode !== "earth") return;
    setStreetOpen(true);
    setMobilePanel("street");
    setStreetIndex(0);
    setStreetPhotos([]);
    setLayerError("street");
    if (GOOGLE_MAPS_API_KEY) {
      setStreetProvider("google");
      setStreetState("loading");
    } else {
      loadKartaViewStreet();
    }
  }, [viewMode, loadKartaViewStreet, setLayerError]);

  const closeStreet = () => { setStreetOpen(false); setMobilePanel("none"); };
  const clearSelection = useCallback(() => {
    setSelected(null);
    setFollowAircraft(false);
    if (viewerRef.current?.trackedEntity) viewerRef.current.trackedEntity = undefined;
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
      setReloadNonce((current) => ({ ...current, traffic: current.traffic + 1 }));
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

      <div ref={containerRef} className={`globe ${viewMode === "space" || streetOpen ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SpaceExplorer planets={planets} sun={sun} time={selectedTime} onSelect={selectEntity} />}

      <header className="topbar glass">
        <div className="brand"><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" && cameraHeight >= GROUND_HEIGHT_M ? "active" : ""} onClick={flyEarth}>EARTH</button>
          <button className={viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "active" : ""} onClick={flyGround}>GROUND</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={() => { setViewMode("space"); setFollowAircraft(false); }}>SPACE</button>
        </div>
        <div className="statusRow"><span className="statusDot" /><span>ws-pv · GEV F1 · {viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "GROUND" : viewMode.toUpperCase()}</span></div>
      </header>

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        <LayerToggle checked={earthquakeLayer} onChange={toggleEarthquakeLayer} onRetry={() => retryLayer("earthquakes")} title="Earthquakes" subtitle="USGS · recent M2.5+ events" state={earthquakeState} count={earthquakes.length} disabled={viewMode !== "earth"} error={layerErrors.earthquakes} />
        <LayerToggle checked={satelliteLayer} onChange={toggleSatelliteLayer} onRetry={() => retryLayer("satellites")} title="Satellites" subtitle={`CelesTrak ${satelliteCatalog.toUpperCase()} · deduped NORAD catalog · SGP4`} state={satelliteState} count={satellites.length} disabled={viewMode !== "earth"} error={layerErrors.satellites} />
        <div className="satelliteCatalogSwitch" role="group" aria-label="Satellite catalog">
          <button className={satelliteCatalog === "core" ? "active" : ""} onClick={() => setSatelliteCatalog("core")}>CORE</button>
          <button className={satelliteCatalog === "dense" ? "active" : ""} onClick={() => setSatelliteCatalog("dense")}>DENSE</button>
        </div>
        <LayerToggle checked={aircraftLayer} onChange={toggleAircraftLayer} onRetry={() => retryLayer("aircraft")} title="Aircraft" subtitle={aircraftAvailable ? `ADS-B · ${aircraftMeta?.provider ?? "adsb.lol / OpenSky"} · ${aircraftRadiusNm} NM · ${renderedAircraft.length}/${visibleAircraft.length} displayed` : "NOW only"} state={aircraftState} count={aircraftAvailable ? aircraft.length : 0} disabled={!aircraftAvailable} error={layerErrors.aircraft} />
        <LayerToggle checked={militaryLayer} onChange={toggleMilitaryLayer} onRetry={() => retryLayer("military")} title="Military" subtitle={aircraftAvailable ? `ADSB.lol · global military snapshot · ${militaryMeta?.stale ? "last-good" : "live"}` : "NOW only"} state={militaryState} count={aircraftAvailable ? military.length : 0} disabled={!aircraftAvailable} error={layerErrors.military} />
        <LayerToggle checked={trafficLayer} onChange={setTrafficLayer} onRetry={() => retryLayer("traffic")} title="Traffic" subtitle="AUTO near ground · OSM roads + modeled vehicles · TomTom when available" state={trafficState} count={trafficVehicleCount} disabled={viewMode !== "earth"} error={layerErrors.traffic} />
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "SPACE"}</em>
          <span>Ground map</span><em>ESRI STREET + DE LABELS · AUTO ON ZOOM</em>
          <span>Street imagery</span><em>GOOGLE + KARTAVIEW</em>
          <span>Annotations</span><em>LOCAL SESSION</em>
          <span>API bridge</span><em>CLOUDFLARE</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {selected
          ? <Inspector entity={selected} onFocus={focusSelected} onStreet={openStreet} onAnnotate={addAnnotation} onClear={clearSelection} followAircraft={followAircraft} onToggleFollow={() => setFollowAircraft((v) => !v)} />
          : <div className="emptyState"><div className="reticle">+</div><p>Select an earthquake, satellite, aircraft or planet.</p><div className="emptyActions"><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level here</button><button className="annotationButton" onClick={addAnnotation} disabled={viewMode !== "earth"}>Mark this location</button></div></div>}
      </section>

      <section className={`timebar glass ${viewMode === "space" ? "spaceTimebar" : ""} ${mobilePanel === "time" ? "mobileOpen" : ""}`}>
        <button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button>
        <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(e) => { setTimeOffsetDays(Number(e.target.value)); setSpacePlaybackDays(0); }} />
        <div className="timeActions">
          <span>{(timeOffsetDays + spacePlaybackDays) > 0 ? `+${(timeOffsetDays + spacePlaybackDays).toFixed(spacePlaybackDays ? 1 : 0)}` : (timeOffsetDays + spacePlaybackDays).toFixed(spacePlaybackDays ? 1 : 0)} days</span>
          {viewMode === "space" && <div className="spaceTimePlayback" role="group" aria-label="Space time playback">
            <button className={spacePlaying ? "active" : ""} onClick={() => setSpacePlaying((playing) => !playing)}>{spacePlaying ? "PAUSE" : "PLAY"}</button>
            {[1, 7, 30].map((rate) => <button key={rate} className={spacePlaybackRate === rate ? "active" : ""} onClick={() => setSpacePlaybackRate(rate)}>{rate}D/S</button>)}
          </div>}
          <button onClick={resetTime}>NOW</button>
        </div>
      </section>

      {!streetOpen && issPreview && <IssLiveHoverCard entity={issPreview.entity} screen={issPreview.screen} onClose={() => setIssPreview(null)} />}

      {streetOpen && <StreetViewer
        provider={streetProvider} googleApiKey={GOOGLE_MAPS_API_KEY}
        state={streetState} photo={currentStreet} index={streetIndex} total={streetPhotos.length}
        error={layerErrors.street} point={streetPoint} onClose={closeStreet}
        onGoogleReady={() => { setStreetState("ready"); setLayerError("street"); }}
        onGoogleFallback={(message) => { loadKartaViewStreet(message); }}
        onUseGoogle={() => { if (GOOGLE_MAPS_API_KEY) { setStreetProvider("google"); setStreetState("loading"); setLayerError("street"); } }}
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

      <footer className="legend glass">
        <span><i className="legendDot observed" /> OBSERVED</span><span><i className="legendDot calculated" /> CALCULATED</span>
        <span>Earth · Ground · Orbit · Solar System</span><span>ws-pv · GEV-derived core lifecycle · independent live sources</span>
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
  const left = screen ? `min(${Math.max(12, screen.x + 18)}px, calc(100vw - 340px))` : "calc(50vw - 160px)";
  const top = screen ? `min(${Math.max(90, screen.y + 18)}px, calc(100vh - 245px))` : "120px";
  return <aside className="issLiveHover glass" style={{ left, top }} aria-label="ISS live video preview">
    <div className="issLiveHead"><span><b>ISS · LIVE 4K</b><small>Sen SpaceTV-1 · interactive preview</small></span><div className="issLiveHeadActions"><em>LIVE</em><button type="button" onClick={onClose}>×</button></div></div>
    <div className="issLiveFrame">
      {ready ? <iframe
        src={`https://www.youtube-nocookie.com/embed/${SEN_ISS_LIVE_VIDEO_ID}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`}
        title="Sen live 4K video from the ISS"
        allow="autoplay; encrypted-media; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      /> : <div className="issLiveLoading">Hold on ISS to start live video…</div>}
    </div>
    <div className="issLiveCaveat">Live camera may be dark on Earth's night side or during ISS signal loss.</div>
    <div className="issLiveMeta"><span>{entity.name}</span><a href="https://www.sen.com/live" target="_blank" rel="noreferrer">Open Sen live ↗</a></div>
  </aside>;
}

function StreetViewer({ provider, googleApiKey, state, photo, index, total, error, point, onClose, onPrevious, onNext, onGoogleReady, onGoogleFallback, onUseGoogle, onUseKartaView }: { provider: StreetProvider; googleApiKey: string; state: LoadState; photo: StreetPhoto | null; index: number; total: number; error?: string; point: EarthPoint; onClose: () => void; onPrevious: () => void; onNext: () => void; onGoogleReady: () => void; onGoogleFallback: (message: string) => void; onUseGoogle: () => void; onUseKartaView: () => void }) {
  return <section className="streetViewer glass" aria-label="Street-level imagery">
    <div className="streetHead"><div><p className="panelLabel">GROUND / STREET · {provider === "google" ? "GOOGLE STREET VIEW" : "KARTAVIEW"}</p><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong></div><button onClick={onClose}>×</button></div>
    <div className="streetProviderSwitch" role="group" aria-label="Street imagery provider">
      <button className={provider === "google" ? "active" : ""} disabled={!googleApiKey} onClick={onUseGoogle}>Google Street View</button>
      <button className={provider === "kartaview" ? "active" : ""} onClick={onUseKartaView}>KartaView fallback</button>
    </div>
    <div className="streetFrame">
      {provider === "google" ? <GoogleStreetPanorama apiKey={googleApiKey} point={point} onReady={onGoogleReady} onFallback={onGoogleFallback} /> : <>
        {state === "loading" && <div className="streetMessage">Searching public street imagery…</div>}
        {state !== "loading" && !photo && <div className="streetMessage"><strong>NO COVERAGE</strong><span>{error ?? "No public KartaView imagery was found near this point."}</span></div>}
        {photo && <div className="streetImage" role="img" aria-label="KartaView street-level photo" style={{ backgroundImage: `url("${photo.imageUrl.replace(/"/g, "%22")}")` }} />}
      </>}
    </div>
    {provider === "kartaview" ? <>
      <div className="streetControls"><button onClick={onPrevious} disabled={index <= 0}>← Previous</button><span>{total ? `${index + 1} / ${total}` : "No imagery"}</span><button onClick={onNext} disabled={!total || index >= total - 1}>Next →</button></div>
      {photo && <div className="streetMeta"><span>Captured: {photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : "unknown"}</span><span>Source: KartaView community imagery{photo.distanceMeters != null ? ` · ${photo.distanceMeters} m from requested point` : ""}</span></div>}
    </> : <div className="streetMeta"><span>Interactive 360° panorama</span><span>Source: Google Street View</span></div>}
  </section>;
}

function GoogleStreetPanorama({ apiKey, point, onReady, onFallback }: { apiKey: string; point: EarthPoint; onReady: () => void; onFallback: (message: string) => void }) {
  const panoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let disposed = false;
    if (!apiKey) { onFallback("Google Street View is not configured · using KartaView fallback"); return; }
    loadGoogleMaps(apiKey).then((google) => {
      if (disposed || !panoRef.current) return;
      const service = new google.maps.StreetViewService();
      return service.getPanorama({ location: { lat: point.latitude, lng: point.longitude }, radius: 120 })
        .then(({ data }: any) => {
          if (disposed || !panoRef.current) return;
          const location = data?.location;
          if (!location?.pano) throw new Error("No Google Street View panorama found nearby");
          new google.maps.StreetViewPanorama(panoRef.current, {
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
          onReady();
        });
    }).catch((error: unknown) => {
      if (!disposed) onFallback(error instanceof Error ? `${error.message} · using KartaView fallback` : "Google Street View failed · using KartaView fallback");
    });
    return () => { disposed = true; };
  }, [apiKey, point.latitude, point.longitude]);
  return <div ref={panoRef} className="googleStreetPano"><div className="streetMessage">Loading Google Street View…</div></div>;
}

function loadGoogleMaps(apiKey: string): Promise<any> {
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;
  window.__worldSelectGoogleMapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google));
      existing.addEventListener("error", () => reject(new Error("Google Maps JavaScript API could not be loaded")));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&libraries=streetView`;
    script.async = true;
    script.defer = true;
    script.dataset.worldSelectGoogleMaps = "1";
    script.onload = () => window.google?.maps ? resolve(window.google) : reject(new Error("Google Maps loaded without maps library"));
    script.onerror = () => reject(new Error("Google Maps JavaScript API could not be loaded"));
    document.head.appendChild(script);
  });
  return window.__worldSelectGoogleMapsPromise;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000, center = size / 2, maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => { const orbitRadius = radiusForAu(p.radiusAu); const angle = Math.atan2(p.yAu, p.xAu); return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
