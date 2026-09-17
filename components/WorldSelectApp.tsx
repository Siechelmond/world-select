"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationTles, propagateTles, type SatelliteCatalog, type TleRecord } from "@/lib/celestrak";
import { fetchAircraftSnapshot, projectAircraftPosition, type AircraftFeedMeta } from "@/lib/aircraft";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import { fetchTrafficStatus, type TrafficStatus } from "@/lib/traffic";
import { resolveLayerState, type LayerLoadState as LoadState } from "@/lib/layer-runtime";
import { captureCameraPose, restoreCameraPose, type CesiumCameraPose } from "@/lib/camera";
import { createWorldViewer } from "@/lib/cesium-viewer";
import { findGoogleStreetCoverage, loadGoogleMaps } from "@/lib/google-street";

declare global { interface Window { Cesium?: any; google?: any } }

type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type StreetProvider = "google" | "kartaview";
type EarthPoint = { latitude: number; longitude: number };
type LayerError = { earthquakes?: string; satellites?: string; aircraft?: string; street?: string; traffic?: string };

const DAY_MS = 86_400_000;
const SATELLITE_TICK_MS = 1_000;
const MOBILE_SATELLITE_TICK_MS = 2_000;
const AIRCRAFT_REFRESH_MS = 15_000;
const GROUND_HEIGHT_M = 120_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
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
  const annotationIdsRef = useRef(new Set<string>());
  const trafficLayerRef = useRef<any>(null);
  const trafficIncidentLayerRef = useRef<any>(null);
  const streetCameraPoseRef = useRef<CesiumCameraPose | null>(null);
  const streetRequestRef = useRef(0);

  const [cesiumReady, setCesiumReady] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [tleRecords, setTleRecords] = useState<TleRecord[]>([]);
  const [aircraft, setAircraft] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(false);
  const [satelliteLayer, setSatelliteLayer] = useState(false);
  const [satelliteCatalog, setSatelliteCatalog] = useState<SatelliteCatalog>("core");
  const [aircraftLayer, setAircraftLayer] = useState(false);
  const [trafficLayer, setTrafficLayer] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [earthquakeState, setEarthquakeState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [aircraftState, setAircraftState] = useState<LoadState>("idle");
  const [aircraftMeta, setAircraftMeta] = useState<AircraftFeedMeta | null>(null);
  const [trafficState, setTrafficState] = useState<LoadState>("idle");
  const [trafficStatus, setTrafficStatus] = useState<TrafficStatus | null>(null);
  const [viewCenter, setViewCenter] = useState<EarthPoint>(INITIAL_CENTER);
  const [cameraHeight, setCameraHeight] = useState(9_500_000);
  const [followAircraft, setFollowAircraft] = useState(false);
  const [selected, setSelected] = useState<SpatialEntity | null>(null);
  const [timeOffsetDays, setTimeOffsetDays] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [layerErrors, setLayerErrors] = useState<LayerError>({});
  const [streetPhotos, setStreetPhotos] = useState<StreetPhoto[]>([]);
  const [streetIndex, setStreetIndex] = useState(0);
  const [streetState, setStreetState] = useState<LoadState>("idle");
  const [streetOpen, setStreetOpen] = useState(false);
  const [streetChecking, setStreetChecking] = useState(false);
  const [streetNotice, setStreetNotice] = useState<string | null>(null);
  const [googleStreetPanoId, setGoogleStreetPanoId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Array<{ id: string; latitude: number; longitude: number; label: string }>>([]);
  const [streetProvider, setStreetProvider] = useState<StreetProvider>(GOOGLE_MAPS_API_KEY ? "google" : "kartaview");
  const [reloadNonce, setReloadNonce] = useState({ earthquakes: 0, satellites: 0, aircraft: 0, traffic: 0 });

  const selectedTime = useMemo(
    () => new Date((timeOffsetDays === 0 ? nowTick : Date.now()) + timeOffsetDays * DAY_MS),
    [timeOffsetDays, nowTick],
  );
  const satellites = useMemo(() => propagateTles(tleRecords, selectedTime), [tleRecords, selectedTime]);
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);
  const aircraftAvailable = viewMode === "earth" && timeOffsetDays === 0;
  const aircraftQueryCenter = useMemo(() => {
    const step = cameraHeight < 300_000 ? 0.05 : cameraHeight < 2_000_000 ? 0.15 : 0.35;
    return {
      latitude: Math.round(viewCenter.latitude / step) * step,
      longitude: Math.round(viewCenter.longitude / step) * step,
    };
  }, [viewCenter.latitude, viewCenter.longitude, cameraHeight]);
  const aircraftRadiusNm = cameraHeight < 120_000 ? 70 : cameraHeight < 1_000_000 ? 130 : 220;
  const animateAircraft = cameraHeight < 900_000;
  // Street is map-centered. Selection must never silently redirect a Street lookup
  // to a satellite/aircraft subpoint that the user did not choose as a ground target.
  const streetPoint = viewCenter;
  const annotationPoint = selected && selected.kind !== "celestial-body"
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
    if ((!satelliteLayer && !(aircraftLayer && animateAircraft)) || timeOffsetDays !== 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), isMobile ? MOBILE_SATELLITE_TICK_MS : SATELLITE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [satelliteLayer, aircraftLayer, animateAircraft, timeOffsetDays, isMobile]);

  useEffect(() => {
    if (!earthquakeLayer) return;
    const controller = new AbortController();
    setEarthquakeState("loading");
    setLayerError("earthquakes");
    fetchEarthquakes(controller.signal)
      .then((items) => { setEarthquakes(items); setEarthquakeState("ready"); setLayerError("earthquakes"); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setEarthquakeState("error");
        setLayerError("earthquakes", reason instanceof Error ? reason.message : "USGS feed error");
      });
    return () => controller.abort();
  }, [earthquakeLayer, reloadNonce.earthquakes, setLayerError]);

  useEffect(() => {
    if (!satelliteLayer) return;
    const controller = new AbortController();
    setSatelliteState("loading");
    setLayerError("satellites");
    fetchStationTles(controller.signal, satelliteCatalog)
      .then((records) => {
        setTleRecords(records);
        setSatelliteState(records.length ? "ready" : "error");
        setLayerError("satellites", records.length ? undefined : "CelesTrak returned no visual satellite elements");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setSatelliteState("error");
        setLayerError("satellites", reason instanceof Error ? reason.message : "Satellite feed error");
      });
    return () => controller.abort();
  }, [satelliteLayer, satelliteCatalog, reloadNonce.satellites, setLayerError]);

  useEffect(() => {
    if (!aircraftLayer || !aircraftAvailable) {
      if (!aircraftAvailable) {
        setAircraft([]);
        setAircraftMeta(null);
      }
      return;
    }
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    let hasSuccessfulPayload = aircraft.length > 0;

    const applyItems = (items: SpatialEntity[]) => {
      if (items.length || !hasSuccessfulPayload) setAircraft(items);
      if (items.length) hasSuccessfulPayload = true;
      for (const item of items) {
        const trail = aircraftTrailRef.current.get(item.id) ?? [];
        const last = trail[trail.length - 1];
        if (!last || Math.abs(last.latitude - item.position.latitude) > 0.0001 || Math.abs(last.longitude - item.position.longitude) > 0.0001) {
          trail.push({ ...item.position });
          const maxAircraftTrailPoints = isMobile ? 12 : 30;
          while (trail.length > maxAircraftTrailPoints) trail.shift();
          aircraftTrailRef.current.set(item.id, trail);
        }
      }
    };

    const load = async (initial: boolean): Promise<boolean> => {
      controller?.abort();
      controller = new AbortController();
      if (initial && !hasSuccessfulPayload) {
        setAircraftState("loading");
        setAircraftMeta(null);
        setLayerError("aircraft");
      }
      try {
        const snapshot = await fetchAircraftSnapshot({ latitude: aircraftQueryCenter.latitude, longitude: aircraftQueryCenter.longitude, radiusNm: aircraftRadiusNm }, controller.signal);
        if (disposed) return false;
        const { entities: items, meta } = snapshot;
        setAircraftMeta(meta);
        applyItems(items);

        if (!items.length && !hasSuccessfulPayload) {
          setAircraftState(resolveLayerState({ enabled: true, hasData: false, failed: true }));
          setLayerError("aircraft", `No positioned aircraft returned within ${aircraftRadiusNm} NM · use Retry`);
          return false;
        }

        if (!items.length && hasSuccessfulPayload) {
          setAircraftState(resolveLayerState({ enabled: true, hasData: true, stale: true }));
          setLayerError("aircraft", "Refresh returned no positioned aircraft · keeping last valid snapshot");
          return true;
        }

        const degradedFeed = meta.degraded || meta.stale;
        setAircraftState(resolveLayerState({ enabled: true, hasData: true, stale: degradedFeed }));
        setLayerError("aircraft", degradedFeed
          ? `Using ${meta.cached ? "cached " : ""}${meta.provider} data${meta.sourceAgeSeconds != null ? ` · ${meta.sourceAgeSeconds}s old` : ""}`
          : undefined);
        return true;
      } catch (reason: unknown) {
        if (controller.signal.aborted || disposed) return false;
        if (!hasSuccessfulPayload) {
          setAircraftState(resolveLayerState({ enabled: true, hasData: false, failed: true }));
          setAircraftMeta(null);
          setLayerError("aircraft", reason instanceof Error ? `${reason.message} · use Retry` : "Aircraft feed error · use Retry");
          return false;
        }
        setAircraftState(resolveLayerState({ enabled: true, hasData: true, failed: true }));
        setLayerError("aircraft", "Live refresh delayed · keeping last valid aircraft snapshot");
        return true;
      }
    };

    const schedule = async (initial: boolean) => {
      const ok = await load(initial);
      if (disposed) return;
      // Never overlap slow provider calls. After a cold failure keep retrying in the
      // background instead of stopping permanently until the user presses Retry.
      const delay = ok ? AIRCRAFT_REFRESH_MS : 60_000;
      timer = window.setTimeout(() => { void schedule(false); }, delay);
    };
    void schedule(true);

    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [aircraftLayer, aircraftAvailable, aircraftQueryCenter.latitude, aircraftQueryCenter.longitude, aircraftRadiusNm, reloadNonce.aircraft, setLayerError, isMobile]);

  useEffect(() => {
    if (!trafficLayer || viewMode !== "earth") return;
    const controller = new AbortController();
    setTrafficState("loading");
    setLayerError("traffic");
    fetchTrafficStatus(controller.signal)
      .then((status) => {
        setTrafficStatus(status);
        const usable = status.configured && status.available;
        setTrafficState(usable ? "ready" : "error");
        setLayerError("traffic", usable ? undefined : (status.message || "Traffic source unavailable"));
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setTrafficState("error");
        setLayerError("traffic", reason instanceof Error ? reason.message : "Traffic status error");
      });
    return () => controller.abort();
  }, [trafficLayer, viewMode, reloadNonce.traffic, setLayerError]);

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
    });
    viewerRef.current = lifecycle.viewer;
    return () => {
      lifecycle.destroy();
      viewerRef.current = null;
    };
  }, [cesiumReady, selectEntity]);

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
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;

    if (viewMode !== "earth" || !aircraftLayer || !aircraftAvailable) {
      clearIds(aircraftIdsRef.current);
      return;
    }

    const liveIds = new Set<string>();
    const selectedAircraftId = selected?.kind === "aircraft" ? selected.id : null;

    for (const spatial of aircraft) {
      liveIds.add(spatial.id);
      const isSelected = spatial.id === selectedAircraftId;
      const canProject = spatial.dataState !== "STALE" && (animateAircraft || isSelected);
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

  }, [aircraft, aircraftLayer, aircraftAvailable, viewMode, clearIds, cesiumReady, nowTick, animateAircraft, cameraHeight, aircraftQueryCenter.latitude, aircraftQueryCenter.longitude, aircraftRadiusNm, selected]);

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
    viewerRef.current.camera.flyTo({ destination: window.Cesium.Cartesian3.fromDegrees(viewCenter.longitude, viewCenter.latitude, 6_500_000), duration: 1.0 });
  }, [viewCenter.latitude, viewCenter.longitude]);

  const flyGround = useCallback(() => {
    if (!viewerRef.current || !window.Cesium) return;
    setViewMode("earth"); setFollowAircraft(false);
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

  const fetchKartaViewCoverage = useCallback(async () => {
    return fetchStreetPhotos(streetPoint.latitude, streetPoint.longitude);
  }, [streetPoint.latitude, streetPoint.longitude]);

  const openStreet = useCallback(async () => {
    if (viewMode !== "earth" || streetChecking || streetOpen) return;
    const requestId = ++streetRequestRef.current;
    streetCameraPoseRef.current = captureCameraPose(viewerRef.current);
    setStreetChecking(true);
    setStreetNotice("Checking street imagery coverage…");
    setStreetIndex(0);
    setStreetPhotos([]);
    setGoogleStreetPanoId(null);
    setLayerError("street");

    let googleFallbackReason = "";
    try {
      if (GOOGLE_MAPS_API_KEY) {
        try {
          const coverage = await findGoogleStreetCoverage(GOOGLE_MAPS_API_KEY, streetPoint);
          if (streetRequestRef.current !== requestId) return;
          if (coverage) {
            setGoogleStreetPanoId(coverage.panoId);
            setStreetProvider("google");
            setStreetState("ready");
            setStreetOpen(true);
            setMobilePanel("street");
            setStreetNotice(null);
            return;
          }
          googleFallbackReason = "No Google Street View panorama found nearby";
        } catch (reason: unknown) {
          googleFallbackReason = reason instanceof Error ? reason.message : "Google Street View unavailable";
        }
      } else {
        googleFallbackReason = "Google Street View is not configured";
      }

      try {
        const photos = await fetchKartaViewCoverage();
        if (streetRequestRef.current !== requestId) return;
        if (photos.length) {
          setStreetPhotos(photos);
          setStreetProvider("kartaview");
          setStreetState("ready");
          setStreetOpen(true);
          setMobilePanel("street");
          setStreetNotice(null);
          setLayerError("street", googleFallbackReason ? `${googleFallbackReason} · KartaView fallback active` : undefined);
          return;
        }
        const noCoverage = "No street imagery nearby — staying on Globe";
        setStreetState("error");
        setStreetOpen(false);
        setMobilePanel("none");
        setStreetNotice(noCoverage);
        setLayerError("street", googleFallbackReason ? `${googleFallbackReason} · ${noCoverage}` : noCoverage);
        streetCameraPoseRef.current = null;
      } catch (reason: unknown) {
        if (streetRequestRef.current !== requestId) return;
        const message = reason instanceof Error ? reason.message : "Street imagery error";
        setStreetState("error");
        setStreetOpen(false);
        setMobilePanel("none");
        setStreetNotice("Street imagery unavailable — staying on Globe");
        setLayerError("street", googleFallbackReason ? `${googleFallbackReason} · ${message}` : message);
        streetCameraPoseRef.current = null;
      }
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [viewMode, streetChecking, streetOpen, streetPoint, fetchKartaViewCoverage, setLayerError]);

  const useGoogleStreet = useCallback(async () => {
    if (!GOOGLE_MAPS_API_KEY || streetChecking) return;
    const requestId = ++streetRequestRef.current;
    setStreetChecking(true);
    setStreetNotice("Checking Google Street View coverage…");
    try {
      const coverage = await findGoogleStreetCoverage(GOOGLE_MAPS_API_KEY, streetPoint);
      if (streetRequestRef.current !== requestId) return;
      if (!coverage) {
        setStreetNotice("No Google Street View panorama nearby · keeping current Street view");
        return;
      }
      setGoogleStreetPanoId(coverage.panoId);
      setStreetProvider("google");
      setStreetState("ready");
      setStreetNotice(null);
      setLayerError("street");
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [streetChecking, streetPoint, setLayerError]);

  const useKartaViewStreet = useCallback(async () => {
    if (streetChecking) return;
    if (streetPhotos.length) {
      setStreetProvider("kartaview");
      setStreetState("ready");
      setStreetNotice(null);
      return;
    }
    const requestId = ++streetRequestRef.current;
    setStreetChecking(true);
    setStreetNotice("Checking KartaView coverage…");
    try {
      const photos = await fetchKartaViewCoverage();
      if (streetRequestRef.current !== requestId) return;
      if (!photos.length) {
        setStreetNotice("No KartaView imagery nearby · keeping current Street view");
        return;
      }
      setStreetPhotos(photos);
      setStreetIndex(0);
      setStreetProvider("kartaview");
      setStreetState("ready");
      setStreetNotice(null);
      setLayerError("street");
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [streetChecking, streetPhotos.length, fetchKartaViewCoverage, setLayerError]);

  const closeStreet = useCallback(() => {
    streetRequestRef.current += 1;
    setStreetOpen(false);
    setStreetChecking(false);
    setStreetNotice(null);
    setMobilePanel("none");
    restoreCameraPose(viewerRef.current, window.Cesium, streetCameraPoseRef.current);
    streetCameraPoseRef.current = null;
  }, []);
  const addAnnotation = () => {
    const label = window.prompt("Annotation label", "Marker");
    if (!label?.trim()) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAnnotations((current) => [...current, { id, latitude: annotationPoint.latitude, longitude: annotationPoint.longitude, label: label.trim().slice(0, 48) }]);
  };
  const resetTime = () => { setTimeOffsetDays(0); setNowTick(Date.now()); };
  const retryLayer = (layer: "earthquakes" | "satellites" | "aircraft" | "traffic") => {
    setReloadNonce((current) => ({ ...current, [layer]: current[layer] + 1 }));
  };
  const toggleAircraftLayer = (enabled: boolean) => {
    if (!enabled) {
      setAircraftState("idle");
      setAircraftMeta(null);
      setLayerError("aircraft");
    }
    setAircraftLayer(enabled);
  };
  const togglePanel = (panel: Exclude<MobilePanel, "none">) => setMobilePanel((current) => current === panel ? "none" : panel);
  const currentStreet = streetPhotos[streetIndex] ?? null;

  return (
    <main className="shell">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css" />
      <Script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js" strategy="afterInteractive" onLoad={() => setCesiumReady(true)} onError={() => setLayerError("earthquakes", "CesiumJS could not be loaded")} />

      <div ref={containerRef} className={`globe ${viewMode === "space" || streetOpen ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SolarSystemView planets={planets} sun={sun} onSelect={selectEntity} />}

      <header className="topbar glass">
        <div className="brand"><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" && cameraHeight >= GROUND_HEIGHT_M ? "active" : ""} onClick={() => { if (streetOpen) closeStreet(); flyEarth(); }}>EARTH</button>
          <button className={viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "active" : ""} onClick={() => { if (streetOpen) closeStreet(); flyGround(); }}>GROUND</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={() => { if (streetOpen) closeStreet(); setViewMode("space"); setFollowAircraft(false); }}>SPACE</button>
        </div>
        <div className="statusRow"><span className="statusDot" /><span>v6.0 foundation · {viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "GROUND" : viewMode.toUpperCase()}</span></div>
      </header>

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        <LayerToggle checked={earthquakeLayer} onChange={setEarthquakeLayer} onRetry={() => retryLayer("earthquakes")} title="Earthquakes" subtitle="USGS · recent M2.5+ events" state={earthquakeState} count={earthquakes.length} disabled={viewMode !== "earth"} error={layerErrors.earthquakes} />
        <LayerToggle checked={satelliteLayer} onChange={setSatelliteLayer} onRetry={() => retryLayer("satellites")} title="Satellites" subtitle={`CelesTrak · ${satelliteCatalog.toUpperCase()} · SGP4 live propagation`} state={satelliteState} count={satellites.length} disabled={viewMode !== "earth"} error={layerErrors.satellites} />
        {satelliteLayer && <div className="satelliteCatalogSwitch" role="group" aria-label="Satellite catalog"><button className={satelliteCatalog === "core" ? "active" : ""} onClick={() => setSatelliteCatalog("core")}>CORE</button><button className={satelliteCatalog === "dense" ? "active" : ""} onClick={() => setSatelliteCatalog("dense")}>DENSE</button></div>}
        <LayerToggle checked={aircraftLayer} onChange={toggleAircraftLayer} onRetry={() => retryLayer("aircraft")} title="Aircraft" subtitle={aircraftAvailable ? `ADS-B · ${aircraftMeta?.provider ?? "OpenSky / adsb.lol"} · ${aircraftRadiusNm} NM · ${animateAircraft ? "bounded motion" : "zoom in for motion"}` : "NOW only"} state={aircraftState} count={aircraftAvailable ? aircraft.length : 0} disabled={!aircraftAvailable} error={layerErrors.aircraft} />
        <LayerToggle checked={trafficLayer} onChange={setTrafficLayer} onRetry={() => retryLayer("traffic")} title="Traffic" subtitle="Ground traffic flow · loads on demand" state={trafficState} count={0} disabled={viewMode !== "earth"} error={layerErrors.traffic} />
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "SPACE"}</em>
          <span>Ground map</span><em>ESRI/OSM + EN LABELS</em>
          <span>Street imagery</span><em>GOOGLE + KARTAVIEW</em>
          <span>Annotations</span><em>LOCAL SESSION</em>
          <span>API bridge</span><em>CLOUDFLARE</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {selected
          ? <Inspector entity={selected} onFocus={focusSelected} onStreet={openStreet} onAnnotate={addAnnotation} followAircraft={followAircraft} onToggleFollow={() => setFollowAircraft((v) => !v)} />
          : <div className="emptyState"><div className="reticle">+</div><p>Select an earthquake, satellite, aircraft or planet.</p><div className="emptyActions"><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level here</button><button className="annotationButton" onClick={addAnnotation} disabled={viewMode !== "earth"}>Mark this location</button></div></div>}
      </section>

      <section className={`timebar glass ${mobilePanel === "time" ? "mobileOpen" : ""}`}>
        <button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button>
        <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(e) => setTimeOffsetDays(Number(e.target.value))} />
        <div className="timeActions"><span>{timeOffsetDays > 0 ? `+${timeOffsetDays}` : timeOffsetDays} days</span><button onClick={resetTime}>NOW</button></div>
      </section>

      {streetNotice && <div className="streetNotice" role="status">{streetNotice}</div>}
      {streetOpen && <StreetViewer
        provider={streetProvider} googleApiKey={GOOGLE_MAPS_API_KEY} googlePanoId={googleStreetPanoId}
        state={streetState} photo={currentStreet} index={streetIndex} total={streetPhotos.length}
        error={layerErrors.street} point={streetPoint} onClose={closeStreet}
        onUseGoogle={useGoogleStreet}
        onUseKartaView={useKartaViewStreet}
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
        <span>Earth · Ground · Orbit · Solar System</span><span>v6.0.1 foundation · ground detail · street center · satellite CORE/DENSE</span>
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

function Inspector({ entity, onFocus, onStreet, onAnnotate, followAircraft, onToggleFollow }: { entity: SpatialEntity; onFocus: () => void; onStreet: () => void; onAnnotate: () => void; followAircraft: boolean; onToggleFollow: () => void }) {
  const rows: Array<[string, string]> = [];
  if (entity.kind === "earthquake") rows.push(["Magnitude", String(entity.properties.magnitude ?? "—")], ["Depth", `${entity.properties.depthKm ?? "—"} km`]);
  else if (entity.kind === "satellite") rows.push(["NORAD", String(entity.properties.noradCatalogNumber ?? "—")], ["Altitude", `${entity.properties.altitudeKm ?? "—"} km`], ["Propagation", String(entity.properties.propagation ?? "—")]);
  else if (entity.kind === "aircraft") rows.push(["Provider", String(entity.properties.provider ?? "—")], ["Registration", String(entity.properties.registration ?? "—")], ["Type", String(entity.properties.aircraftType ?? "—")], ["Altitude", `${entity.properties.altitudeFt ?? "—"} ft`], ["Speed", `${entity.properties.groundSpeedKt ?? "—"} kt`], ["Track", `${entity.properties.trackDeg ?? "—"}°`], ["Squawk", String(entity.properties.squawk ?? "—")], ["Motion", String(entity.properties.displayPosition ?? entity.properties.renderModel ?? "—")]);
  else if (entity.kind === "celestial-body") { rows.push(["Distance", `${entity.properties.heliocentricDistanceAu ?? 0} AU`]); if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]); }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button>{entity.kind === "aircraft" ? <button className="followButton" onClick={onToggleFollow}>{followAircraft ? "Stop follow" : "Follow aircraft"}</button> : <button className="streetButton" onClick={onStreet}>Street at map center</button>}<button className="annotationButton" onClick={onAnnotate}>Mark location</button></div>}</>;
}

function StreetViewer({ provider, googleApiKey, googlePanoId, state, photo, index, total, error, point, onClose, onPrevious, onNext, onUseGoogle, onUseKartaView }: { provider: StreetProvider; googleApiKey: string; googlePanoId: string | null; state: LoadState; photo: StreetPhoto | null; index: number; total: number; error?: string; point: EarthPoint; onClose: () => void; onPrevious: () => void; onNext: () => void; onUseGoogle: () => void; onUseKartaView: () => void }) {
  return <section className="streetViewer glass" aria-label="Street-level imagery">
    <div className="streetHead"><div><p className="panelLabel">GROUND / STREET · {provider === "google" ? "GOOGLE STREET VIEW" : "KARTAVIEW"}</p><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong></div><button className="backToGlobe" onClick={onClose}>← Back to Globe</button></div>
    <div className="streetProviderSwitch" role="group" aria-label="Street imagery provider">
      <button className={provider === "google" ? "active" : ""} disabled={!googleApiKey} onClick={onUseGoogle}>Google Street View</button>
      <button className={provider === "kartaview" ? "active" : ""} onClick={onUseKartaView}>KartaView fallback</button>
    </div>
    <div className="streetFrame">
      {provider === "google" && googlePanoId ? <GoogleStreetPanorama apiKey={googleApiKey} panoId={googlePanoId} /> : <>
        {state === "loading" && <div className="streetMessage">Searching public street imagery…</div>}
        {state !== "loading" && !photo && <div className="streetMessage"><strong>NO IMAGERY</strong><span>{error ?? "No public street imagery is available for this provider."}</span></div>}
        {photo && <div className="streetImage" role="img" aria-label="KartaView street-level photo" style={{ backgroundImage: `url("${photo.imageUrl.replace(/"/g, "%22")}")` }} />}
      </>}
    </div>
    {provider === "kartaview" ? <>
      <div className="streetControls"><button onClick={onPrevious} disabled={index <= 0}>← Previous</button><span>{total ? `${index + 1} / ${total}` : "No imagery"}</span><button onClick={onNext} disabled={!total || index >= total - 1}>Next →</button></div>
      {photo && <div className="streetMeta"><span>Captured: {photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : "unknown"}</span><span>Source: KartaView community imagery{photo.distanceMeters != null ? ` · ${photo.distanceMeters} m from requested point` : ""}</span></div>}
    </> : <div className="streetMeta"><span>Interactive 360° panorama</span><span>Source: Google Street View</span></div>}
  </section>;
}

function GoogleStreetPanorama({ apiKey, panoId }: { apiKey: string; panoId: string }) {
  const panoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let disposed = false;
    loadGoogleMaps(apiKey).then((google) => {
      if (disposed || !panoRef.current) return;
      new google.maps.StreetViewPanorama(panoRef.current, {
        pano: panoId,
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        addressControl: true,
        fullscreenControl: !window.matchMedia("(max-width: 780px)").matches,
        motionTracking: false,
        linksControl: true,
        panControl: true,
        zoomControl: true,
      });
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [apiKey, panoId]);
  return <div ref={panoRef} className="googleStreetPano"><div className="streetMessage">Loading Google Street View…</div></div>;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000, center = size / 2, maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => { const orbitRadius = radiusForAu(p.radiusAu); const angle = Math.atan2(p.yAu, p.xAu); return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
