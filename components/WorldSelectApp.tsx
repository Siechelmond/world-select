"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationTles, propagateTles, type TleRecord } from "@/lib/celestrak";
import { fetchAircraftNear, projectAircraftPosition } from "@/lib/aircraft";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import { GEO_LABELS_DE } from "@/lib/geo-labels";
import { fetchTrafficStatus, type TrafficStatus } from "@/lib/traffic";

declare global { interface Window { Cesium?: any } }

type LoadState = "idle" | "loading" | "ready" | "error";
type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type EarthPoint = { latitude: number; longitude: number };
type LayerError = { earthquakes?: string; satellites?: string; aircraft?: string; street?: string; traffic?: string };

const DAY_MS = 86_400_000;
const SATELLITE_TICK_MS = 1_000;
const MOBILE_SATELLITE_TICK_MS = 2_000;
const AIRCRAFT_REFRESH_MS = 15_000;
const GROUND_HEIGHT_M = 120_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };

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
  const trafficLayerRef = useRef<any>(null);
  const aircraftCoverageRef = useRef<any>(null);
  const aircraftManualGateRef = useRef({ blocked: false });

  const [cesiumReady, setCesiumReady] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [tleRecords, setTleRecords] = useState<TleRecord[]>([]);
  const [aircraft, setAircraft] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(false);
  const [satelliteLayer, setSatelliteLayer] = useState(false);
  const [aircraftLayer, setAircraftLayer] = useState(false);
  const [trafficLayer, setTrafficLayer] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [earthquakeState, setEarthquakeState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [aircraftState, setAircraftState] = useState<LoadState>("idle");
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
    fetchStationTles(controller.signal)
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
  }, [satelliteLayer, reloadNonce.satellites, setLayerError]);

  useEffect(() => {
    if (!aircraftLayer || !aircraftAvailable) {
      if (!aircraftAvailable) setAircraft([]);
      return;
    }
    if (aircraftManualGateRef.current.blocked) return;

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
        setLayerError("aircraft");
      }
      try {
        const items = await fetchAircraftNear({ latitude: aircraftQueryCenter.latitude, longitude: aircraftQueryCenter.longitude, radiusNm: aircraftRadiusNm }, controller.signal);
        if (disposed) return false;
        applyItems(items);
        if (!items.length && !hasSuccessfulPayload) {
          aircraftManualGateRef.current.blocked = true;
          setAircraftState("error");
          setLayerError("aircraft", `No aircraft returned within ${aircraftRadiusNm} NM of the current view`);
          return false;
        }
        setAircraftState("ready");
        setLayerError("aircraft", items.length ? undefined : "Live refresh delayed · keeping last known aircraft");
        return true;
      } catch (reason: unknown) {
        if (controller.signal.aborted || disposed) return false;
        if (!hasSuccessfulPayload) {
          aircraftManualGateRef.current.blocked = true;
          setAircraftState("error");
          setLayerError("aircraft", reason instanceof Error ? reason.message : "Aircraft feed error");
          return false;
        }
        // Background refreshes never throw the visible layer back into Loading/Error.
        setAircraftState("ready");
        setLayerError("aircraft", "Live refresh delayed · keeping last known aircraft");
        return true;
      }
    };

    void (async () => {
      const ok = await load(true);
      if (!ok || disposed) return;
      timer = window.setInterval(() => { void load(false); }, AIRCRAFT_REFRESH_MS);
    })();

    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearInterval(timer);
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
        setTrafficState(status.configured ? "ready" : "error");
        setLayerError("traffic", status.configured ? undefined : "Traffic is not configured yet");
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
    const Cesium = window.Cesium;
    Cesium.Ion.defaultAccessToken = undefined;
    const viewer = new Cesium.Viewer(containerRef.current, {
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
      homeButton: true, sceneModePicker: false, navigationHelpButton: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })),
    });
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#020617");
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000) });

    for (const label of GEO_LABELS_DE) {
      const id = `geo-label:${label.id}`;
      geoLabelIdsRef.current.add(id);
      viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(label.longitude, label.latitude, 0),
        label: {
          text: label.name,
          font: label.kind === "country" ? "600 15px sans-serif" : label.kind === "water" ? "italic 13px sans-serif" : "600 12px sans-serif",
          fillColor: label.kind === "water" ? Cesium.Color.fromCssColorString("#93c5fd") : Cesium.Color.fromCssColorString("#f8fafc"),
          outlineColor: Cesium.Color.fromCssColorString("#020617"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(label.minHeight, label.maxHeight),
          translucencyByDistance: new Cesium.NearFarScalar(label.minHeight || 1, 1, label.maxHeight, 0.35),
          disableDepthTestDistance: 0,
        },
      });
    }

    const updateViewCenter = () => {
      const canvas = viewer.scene.canvas;
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const cartesian = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid);
      if (!cartesian) return;
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const latitude = Cesium.Math.toDegrees(cartographic.latitude);
      const longitude = Cesium.Math.toDegrees(cartographic.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) setViewCenter({ latitude, longitude });
      const height = viewer.camera.positionCartographic?.height;
      if (Number.isFinite(height)) setCameraHeight(height);
    };

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: any) => {
      const picked = viewer.scene.pick(movement.position);
      const id = picked?.id?.id;
      if (typeof id === "string") {
        const spatial = entityMapRef.current.get(id);
        if (spatial) selectEntity(spatial);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewer.camera.moveEnd.addEventListener(updateViewCenter);
    viewerRef.current = viewer;
    updateViewCenter();
    return () => {
      viewer.camera.moveEnd.removeEventListener(updateViewCenter);
      handler.destroy();
      viewer.destroy();
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
    for (const spatial of satellites) {
      liveIds.add(spatial.id); entityMapRef.current.set(spatial.id, spatial);
      const position = Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, spatial.position.altitudeMeters);
      const existing = viewer.entities.getById(spatial.id);
      const trail = satelliteTrailRef.current.get(spatial.id) ?? [];
      const last = trail[trail.length - 1];
      const moved = !last || Cesium.Cartesian3.distance(last, position) > 2_000;
      if (moved) trail.push(position);
      const maxTrailPoints = isMobile ? 10 : 30;
      while (trail.length > maxTrailPoints) trail.shift();
      satelliteTrailRef.current.set(spatial.id, trail);
      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(position);
        if (existing.polyline) existing.polyline.positions = new Cesium.ConstantProperty([...trail]);
      } else {
        satIdsRef.current.add(spatial.id);
        viewer.entities.add({
          id: spatial.id, position,
          point: { pixelSize: 9, color: Cesium.Color.fromCssColorString("#67e8f9"), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
          polyline: { positions: [...trail], width: 1.5, material: Cesium.Color.fromCssColorString("#67e8f9").withAlpha(0.45) },
          label: {
            text: spatial.name.includes("ISS") || spatial.name.includes("TIANHE") ? spatial.name : "",
            font: "11px sans-serif", fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(10, -10),
          },
        });
      }
    }
    for (const id of Array.from(satIdsRef.current) as string[]) {
      if (!liveIds.has(id)) { viewer.entities.removeById(id); entityMapRef.current.delete(id); satIdsRef.current.delete(id); }
    }
  }, [satellites, satelliteLayer, viewMode, clearIds, cesiumReady, isMobile]);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;

    if (aircraftCoverageRef.current) {
      viewer.entities.remove(aircraftCoverageRef.current);
      aircraftCoverageRef.current = null;
    }

    if (viewMode !== "earth" || !aircraftLayer || !aircraftAvailable) {
      clearIds(aircraftIdsRef.current);
      return;
    }

    // Make the real query footprint explicit. Aircraft data is regional, not a fake global layer.
    aircraftCoverageRef.current = viewer.entities.add({
      id: "aircraft-query-coverage",
      position: Cesium.Cartesian3.fromDegrees(aircraftQueryCenter.longitude, aircraftQueryCenter.latitude, 0),
      ellipse: {
        semiMajorAxis: aircraftRadiusNm * 1852,
        semiMinorAxis: aircraftRadiusNm * 1852,
        material: Cesium.Color.fromCssColorString("#facc15").withAlpha(0.035),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#facc15").withAlpha(0.35),
        height: 0,
      },
    });

    const liveIds = new Set<string>();
    const selectedAircraftId = selected?.kind === "aircraft" ? selected.id : null;

    for (const spatial of aircraft) {
      liveIds.add(spatial.id);
      const isSelected = spatial.id === selectedAircraftId;
      const projected = animateAircraft || isSelected ? projectAircraftPosition(spatial, nowTick) : spatial.position;
      const displayEntity: SpatialEntity = {
        ...spatial,
        position: projected,
        dataState: animateAircraft || isSelected ? "ESTIMATED" : spatial.dataState,
        properties: {
          ...spatial.properties,
          displayPosition: animateAircraft || isSelected ? "estimated between observed ADS-B samples" : "last observed ADS-B sample",
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

      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(position);
        if (existing.point) existing.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
        if (existing.polyline) {
          existing.polyline.show = new Cesium.ConstantProperty(isSelected && trailPositions.length > 1);
          existing.polyline.positions = new Cesium.ConstantProperty(trailPositions);
        }
        if (existing.label) {
          existing.label.show = new Cesium.ConstantProperty(isSelected);
          existing.label.text = new Cesium.ConstantProperty(`✈ ${spatial.name}`);
        }
      } else {
        aircraftIdsRef.current.add(spatial.id);
        viewer.entities.add({
          id: spatial.id,
          position,
          point: {
            pixelSize,
            color: Cesium.Color.fromCssColorString("#facc15"),
            outlineColor: Cesium.Color.fromCssColorString("#fef9c3"),
            outlineWidth: isSelected ? 2 : 0.5,
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
            text: `✈ ${spatial.name}`,
            font: "11px sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#fef08a"),
            pixelOffset: new Cesium.Cartesian2(10, -11),
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
  }, [aircraft, aircraftLayer, aircraftAvailable, viewMode, clearIds, cesiumReady, nowTick, animateAircraft, cameraHeight, aircraftQueryCenter.latitude, aircraftQueryCenter.longitude, aircraftRadiusNm, selected]);


  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    if (trafficLayerRef.current) {
      viewer.imageryLayers.remove(trafficLayerRef.current, true);
      trafficLayerRef.current = null;
    }
    if (viewMode !== "earth" || !trafficLayer || !trafficStatus?.configured) return;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: "/api/traffic?z={z}&x={x}&y={y}",
      minimumLevel: 4,
      maximumLevel: 18,
      credit: "Traffic © TomTom",
    });
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = 0.72;
    trafficLayerRef.current = layer;
    return () => {
      if (trafficLayerRef.current && viewerRef.current) {
        viewerRef.current.imageryLayers.remove(trafficLayerRef.current, true);
        trafficLayerRef.current = null;
      }
    };
  }, [trafficLayer, trafficStatus?.configured, viewMode, cesiumReady]);

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

  const openStreet = useCallback(() => {
    if (viewMode !== "earth") return;
    setStreetOpen(true); setMobilePanel("street"); setStreetState("loading"); setStreetIndex(0); setStreetPhotos([]); setLayerError("street");
    const controller = new AbortController();
    fetchStreetPhotos(streetPoint.latitude, streetPoint.longitude, controller.signal)
      .then((photos) => {
        setStreetPhotos(photos); setStreetState("ready");
        if (!photos.length) setLayerError("street", "No KartaView street imagery found at this location");
      })
      .catch((reason: unknown) => {
        setStreetState("error"); setLayerError("street", reason instanceof Error ? reason.message : "Street imagery error");
      });
  }, [streetPoint.latitude, streetPoint.longitude, viewMode, setLayerError]);

  const closeStreet = () => { setStreetOpen(false); setMobilePanel("none"); };
  const resetTime = () => { setTimeOffsetDays(0); setNowTick(Date.now()); };
  const retryLayer = (layer: "earthquakes" | "satellites" | "aircraft" | "traffic") => {
    if (layer === "aircraft") aircraftManualGateRef.current.blocked = false;
    setReloadNonce((current) => ({ ...current, [layer]: current[layer] + 1 }));
  };
  const toggleAircraftLayer = (enabled: boolean) => {
    if (enabled) aircraftManualGateRef.current.blocked = false;
    else {
      setAircraftState("idle");
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

      <div ref={containerRef} className={`globe ${viewMode === "space" ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SolarSystemView planets={planets} sun={sun} onSelect={selectEntity} />}

      <header className="topbar glass">
        <div className="brand"><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" && cameraHeight >= GROUND_HEIGHT_M ? "active" : ""} onClick={flyEarth}>EARTH</button>
          <button className={viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "active" : ""} onClick={flyGround}>GROUND</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={() => { setViewMode("space"); setFollowAircraft(false); }}>SPACE</button>
        </div>
        <div className="statusRow"><span className="statusDot" /><span>v4.2.2 · {viewMode === "earth" && cameraHeight < GROUND_HEIGHT_M ? "GROUND" : viewMode.toUpperCase()}</span></div>
      </header>

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        <LayerToggle checked={earthquakeLayer} onChange={setEarthquakeLayer} onRetry={() => retryLayer("earthquakes")} title="Earthquakes" subtitle="USGS · recent M2.5+ events" state={earthquakeState} count={earthquakes.length} disabled={viewMode !== "earth"} error={layerErrors.earthquakes} />
        <LayerToggle checked={satelliteLayer} onChange={setSatelliteLayer} onRetry={() => retryLayer("satellites")} title="Satellites" subtitle="CelesTrak · SGP4 live propagation" state={satelliteState} count={satellites.length} disabled={viewMode !== "earth"} error={layerErrors.satellites} />
        <LayerToggle checked={aircraftLayer} onChange={toggleAircraftLayer} onRetry={() => retryLayer("aircraft")} title="Aircraft" subtitle={aircraftAvailable ? `ADS-B · regional ${aircraftRadiusNm} NM · ${animateAircraft ? "live motion" : "zoom in for motion"}` : "NOW only"} state={aircraftState} count={aircraftAvailable ? aircraft.length : 0} disabled={!aircraftAvailable} error={layerErrors.aircraft} />
        <LayerToggle checked={trafficLayer} onChange={setTrafficLayer} onRetry={() => retryLayer("traffic")} title="Traffic" subtitle="Ground traffic flow · loads on demand" state={trafficState} count={trafficStatus?.configured && trafficLayer ? 1 : 0} disabled={viewMode !== "earth"} error={layerErrors.traffic} />
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "SPACE"}</em>
          <span>Ground map</span><em>OSM + DE LABELS</em>
          <span>Street imagery</span><em>KARTAVIEW IN-APP</em>
          <span>API bridge</span><em>CLOUDFLARE</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {selected
          ? <Inspector entity={selected} onFocus={focusSelected} onStreet={openStreet} followAircraft={followAircraft} onToggleFollow={() => setFollowAircraft((v) => !v)} />
          : <div className="emptyState"><div className="reticle">+</div><p>Select an earthquake, satellite, aircraft or planet.</p><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level here</button></div>}
      </section>

      <section className={`timebar glass ${mobilePanel === "time" ? "mobileOpen" : ""}`}>
        <button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button>
        <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(e) => setTimeOffsetDays(Number(e.target.value))} />
        <div className="timeActions"><span>{timeOffsetDays > 0 ? `+${timeOffsetDays}` : timeOffsetDays} days</span><button onClick={resetTime}>NOW</button></div>
      </section>

      {streetOpen && <StreetViewer
        state={streetState} photo={currentStreet} index={streetIndex} total={streetPhotos.length}
        error={layerErrors.street} point={streetPoint} onClose={closeStreet}
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
        <span>Earth · Ground · Orbit · Solar System</span><span>v4.2.2 · stable layer states · lazy layers · mobile-first · DE geography</span>
      </footer>
    </main>
  );
}

function LayerToggle({ checked, onChange, onRetry, title, subtitle, state, count, disabled = false, error }: { checked: boolean; onChange: (v: boolean) => void; onRetry: () => void; title: string; subtitle: string; state: LoadState; count: number; disabled?: boolean; error?: string }) {
  const effectiveState: LoadState | "off" = checked ? state : "off";
  const statusText = effectiveState === "off" ? "Off"
    : effectiveState === "loading" ? "Loading…"
    : effectiveState === "ready" ? `Live · ${count}`
    : effectiveState === "error" ? "Unavailable" : "Ready to load";
  return <div className={`layerCard ${disabled ? "disabled" : ""} ${effectiveState === "error" ? "layerError" : ""}`}>
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
      {effectiveState === "off" && <small>Tap to load</small>}
      {effectiveState === "error" && <><small>{error ? "Live source unavailable" : "Load failed"}</small><button type="button" onClick={onRetry}>Retry</button></>}
    </div>
  </div>;
}

function Inspector({ entity, onFocus, onStreet, followAircraft, onToggleFollow }: { entity: SpatialEntity; onFocus: () => void; onStreet: () => void; followAircraft: boolean; onToggleFollow: () => void }) {
  const rows: Array<[string, string]> = [];
  if (entity.kind === "earthquake") rows.push(["Magnitude", String(entity.properties.magnitude ?? "—")], ["Depth", `${entity.properties.depthKm ?? "—"} km`]);
  else if (entity.kind === "satellite") rows.push(["NORAD", String(entity.properties.noradCatalogNumber ?? "—")], ["Altitude", `${entity.properties.altitudeKm ?? "—"} km`], ["Propagation", String(entity.properties.propagation ?? "—")]);
  else if (entity.kind === "aircraft") rows.push(["Provider", String(entity.properties.provider ?? "—")], ["Registration", String(entity.properties.registration ?? "—")], ["Type", String(entity.properties.aircraftType ?? "—")], ["Altitude", `${entity.properties.altitudeFt ?? "—"} ft`], ["Speed", `${entity.properties.groundSpeedKt ?? "—"} kt`], ["Track", `${entity.properties.trackDeg ?? "—"}°`], ["Squawk", String(entity.properties.squawk ?? "—")], ["Motion", String(entity.properties.displayPosition ?? entity.properties.renderModel ?? "—")]);
  else if (entity.kind === "celestial-body") { rows.push(["Distance", `${entity.properties.heliocentricDistanceAu ?? 0} AU`]); if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]); }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button>{entity.kind === "aircraft" ? <button className="followButton" onClick={onToggleFollow}>{followAircraft ? "Stop follow" : "Follow aircraft"}</button> : <button className="streetButton" onClick={onStreet}>Street imagery</button>}</div>}</>;
}

function StreetViewer({ state, photo, index, total, error, point, onClose, onPrevious, onNext }: { state: LoadState; photo: StreetPhoto | null; index: number; total: number; error?: string; point: EarthPoint; onClose: () => void; onPrevious: () => void; onNext: () => void }) {
  return <section className="streetViewer glass" aria-label="Street-level imagery">
    <div className="streetHead"><div><p className="panelLabel">STREET LEVEL · KARTAVIEW</p><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong></div><button onClick={onClose}>×</button></div>
    <div className="streetFrame">
      {state === "loading" && <div className="streetMessage">Searching public street imagery…</div>}
      {state !== "loading" && !photo && <div className="streetMessage"><strong>NO COVERAGE</strong><span>{error ?? "No public KartaView imagery was found near this point."}</span></div>}
      {photo && <div className="streetImage" role="img" aria-label="KartaView street-level photo" style={{ backgroundImage: `url("${photo.imageUrl.replace(/"/g, "%22")}")` }} />}
    </div>
    <div className="streetControls"><button onClick={onPrevious} disabled={index <= 0}>← Previous</button><span>{total ? `${index + 1} / ${total}` : "No imagery"}</span><button onClick={onNext} disabled={!total || index >= total - 1}>Next →</button></div>
    {photo && <div className="streetMeta"><span>Captured: {photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : "unknown"}</span><span>Source: KartaView community imagery</span></div>}
  </section>;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000, center = size / 2, maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => { const orbitRadius = radiusForAu(p.radiusAu); const angle = Math.atan2(p.yAu, p.xAu); return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
