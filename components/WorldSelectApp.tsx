"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";
import { findGoogleStreetCoverage, loadGoogleMaps } from "@/lib/google-street";
import { fetchRoute as fetchWorldRoute, formatDistance, formatDuration, type RoutePoint, type RouteProfile, type RouteResult } from "@/lib/directions";
import type { CesiumCameraPose } from "@/lib/camera";
import { WorldSelectRuntime } from "@/runtime/app/application";
import type { RuntimeLayerId, RuntimeLayerState, RuntimeSnapshot } from "@/runtime/types";

declare global { interface Window { Cesium?: any; google?: any } }

type SatelliteCatalog = "core" | "dense";
type LoadState = "idle" | "loading" | "ready" | "degraded" | "error";
type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type StreetProvider = "google" | "kartaview";
type AircraftFilter = "all" | "civilian" | "military";
type RouteArm = "a" | "b" | null;
type EarthPoint = { latitude: number; longitude: number };

const DAY_MS = 86_400_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
const SEN_ISS_LIVE_VIDEO_ID = process.env.NEXT_PUBLIC_SEN_ISS_LIVE_VIDEO_ID ?? "fO9e9jnhYK8";

function toLoadState(state: RuntimeLayerState): LoadState {
  if (state === "live") return "ready";
  if (state === "unavailable") return "error";
  return state;
}

export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<WorldSelectRuntime | null>(null);
  const streetCameraPoseRef = useRef<CesiumCameraPose | null>(null);
  const streetRequestRef = useRef(0);
  const routeRequestRef = useRef<AbortController | null>(null);
  const routeARef = useRef<RoutePoint | null>(null);
  const routeBRef = useRef<RoutePoint | null>(null);
  const resumeAircraftRef = useRef(false);

  const [cesiumReady, setCesiumReady] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [groundMode, setGroundMode] = useState(false);
  const [satelliteCatalog, setSatelliteCatalog] = useState<SatelliteCatalog>("core");
  const [aircraftFilter, setAircraftFilter] = useState<AircraftFilter>("all");
  const [timeOffsetDays, setTimeOffsetDays] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");

  const [streetPhotos, setStreetPhotos] = useState<StreetPhoto[]>([]);
  const [streetIndex, setStreetIndex] = useState(0);
  const [streetState, setStreetState] = useState<LoadState>("idle");
  const [streetOpen, setStreetOpen] = useState(false);
  const [streetChecking, setStreetChecking] = useState(false);
  const [streetNotice, setStreetNotice] = useState<string | null>(null);
  const [streetError, setStreetError] = useState<string | undefined>(undefined);
  const [googleStreetPanoId, setGoogleStreetPanoId] = useState<string | null>(null);
  const [streetProvider, setStreetProvider] = useState<StreetProvider>(GOOGLE_MAPS_API_KEY ? "google" : "kartaview");
  const [annotations, setAnnotations] = useState<Array<{ id: string; latitude: number; longitude: number; label: string }>>([]);
  const [routeMode, setRouteMode] = useState<RouteProfile>("foot");
  const [routeA, setRouteA] = useState<RoutePoint | null>(null);
  const [routeB, setRouteB] = useState<RoutePoint | null>(null);
  const [routeArm, setRouteArm] = useState<RouteArm>(null);
  const [routeState, setRouteState] = useState<"idle" | "routing" | "ready" | "error">("idle");
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  const selectedTime = useMemo(
    () => new Date((timeOffsetDays === 0 ? nowTick : Date.now()) + timeOffsetDays * DAY_MS),
    [timeOffsetDays, nowTick],
  );
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);
  const selected = snapshot?.selected ?? null;
  const hovered = snapshot?.hovered ?? null;
  const viewCenter = snapshot ? { latitude: snapshot.camera.latitude, longitude: snapshot.camera.longitude } : INITIAL_CENTER;
  const streetPoint = selected && selected.kind !== "celestial-body"
    ? { latitude: selected.position.latitude, longitude: selected.position.longitude }
    : viewCenter;
  const annotationPoint = selected && selected.kind !== "celestial-body"
    ? { latitude: selected.position.latitude, longitude: selected.position.longitude }
    : viewCenter;

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 760px)").matches);
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (viewMode !== "space" || timeOffsetDays !== 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [viewMode, timeOffsetDays]);

  useEffect(() => {
    if (!cesiumReady || !containerRef.current || !window.Cesium || runtimeRef.current) return;
    let runtime: WorldSelectRuntime | null = null;
    try {
      runtime = new WorldSelectRuntime({
        Cesium: window.Cesium,
        container: containerRef.current,
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
      });
      runtimeRef.current = runtime;
      const unsubscribe = runtime.subscribe((next) => setSnapshot(next));
      setRuntimeReady(true);
      setRuntimeError(null);
      // Stage live layers so the keyless basemap becomes interactive before
      // expensive network/provider work competes for the first paint.
      const bootTimers = [
        window.setTimeout(() => void runtime?.setLayerEnabled("earthquakes", true), 150),
        window.setTimeout(() => void runtime?.setLayerEnabled("satellites", true), 400),
        window.setTimeout(() => void runtime?.setLayerEnabled("aircraft", true), 900),
        window.setTimeout(() => void runtime?.setLayerEnabled("traffic", true), 1400),
      ];
      return () => {
        bootTimers.forEach((timer) => window.clearTimeout(timer));
        unsubscribe();
        runtime?.destroy();
        if (runtimeRef.current === runtime) runtimeRef.current = null;
        setRuntimeReady(false);
      };
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : "Spatial runtime failed to initialize";
      setRuntimeError(message);
      runtime?.destroy();
      runtimeRef.current = null;
    }
  }, [cesiumReady]);

  useEffect(() => {
    runtimeRef.current?.setAnnotations(annotations);
  }, [annotations]);

  const setLayerEnabled = useCallback((id: RuntimeLayerId, enabled: boolean) => {
    void runtimeRef.current?.setLayerEnabled(id, enabled);
  }, []);

  const retryLayer = useCallback((id: RuntimeLayerId) => {
    void runtimeRef.current?.retryLayer(id);
  }, []);

  const selectEntity = useCallback((entity: SpatialEntity) => {
    runtimeRef.current?.select(entity);
    setMobilePanel("inspector");
  }, []);

  const flyEarth = useCallback(() => {
    setViewMode("earth");
    setGroundMode(false);
    runtimeRef.current?.setFollowAircraft(false);
    runtimeRef.current?.setSceneActive(true);
    runtimeRef.current?.flyEarth();
  }, []);

  const flyGround = useCallback(() => {
    setViewMode("earth");
    setGroundMode(true);
    runtimeRef.current?.setFollowAircraft(false);
    runtimeRef.current?.setSceneActive(true);
    runtimeRef.current?.flyGround();
  }, []);

  const flySpace = useCallback(() => {
    setViewMode("space");
    setGroundMode(false);
    runtimeRef.current?.setFollowAircraft(false);
    runtimeRef.current?.setSceneActive(false);
  }, []);

  const focusSelected = useCallback(() => runtimeRef.current?.focusSelected(), []);

  const changeSatelliteCatalog = useCallback((catalog: SatelliteCatalog) => {
    setSatelliteCatalog(catalog);
    runtimeRef.current?.setSatelliteCatalog(catalog);
  }, []);

  const changeAircraftFilter = useCallback((filter: AircraftFilter) => {
    setAircraftFilter(filter);
    runtimeRef.current?.setAircraftDisplayMode(filter);
  }, []);

  const requestRoute = useCallback(async (a: RoutePoint, b: RoutePoint, mode: RouteProfile) => {
    routeRequestRef.current?.abort();
    const controller = new AbortController();
    routeRequestRef.current = controller;
    setRouteState("routing");
    setRouteError(null);
    setRouteResult(null);
    try {
      const result = await fetchWorldRoute(a, b, mode, controller.signal);
      if (controller.signal.aborted) return;
      setRouteResult(result);
      setRouteState("ready");
      runtimeRef.current?.showRoute(a, b, result);
    } catch (reason: unknown) {
      if (controller.signal.aborted) return;
      setRouteState("error");
      setRouteError(reason instanceof Error ? reason.message : "Route unavailable");
    }
  }, []);

  const armRoutePoint = useCallback((which: Exclude<RouteArm, null>) => {
    const runtime = runtimeRef.current;
    if (!runtime || viewMode !== "earth") return;
    if (routeArm === which) {
      runtime.cancelMapPointCapture();
      setRouteArm(null);
      return;
    }
    setRouteArm(which);
    runtime.captureNextMapPoint((point) => {
      if (which === "a") {
        routeARef.current = point;
        setRouteA(point);
      } else {
        routeBRef.current = point;
        setRouteB(point);
      }
      setRouteArm(null);
      const a = which === "a" ? point : routeARef.current;
      const b = which === "b" ? point : routeBRef.current;
      if (a && b) void requestRoute(a, b, routeMode);
    });
  }, [routeArm, routeMode, requestRoute, viewMode]);

  const changeRouteMode = useCallback((mode: RouteProfile) => {
    setRouteMode(mode);
    const a = routeARef.current;
    const b = routeBRef.current;
    if (a && b) void requestRoute(a, b, mode);
  }, [requestRoute]);

  const clearRoute = useCallback(() => {
    routeRequestRef.current?.abort();
    routeRequestRef.current = null;
    routeARef.current = null;
    routeBRef.current = null;
    setRouteA(null);
    setRouteB(null);
    setRouteArm(null);
    setRouteResult(null);
    setRouteError(null);
    setRouteState("idle");
    runtimeRef.current?.clearRoute();
  }, []);

  const changeTimeOffset = useCallback((days: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      setTimeOffsetDays(days);
      return;
    }
    if (days !== 0 && snapshot?.layers.aircraft.enabled) resumeAircraftRef.current = true;
    setTimeOffsetDays(days);
    runtime.setTimeOffsetDays(days);
    if (days === 0 && resumeAircraftRef.current) {
      resumeAircraftRef.current = false;
      void runtime.setLayerEnabled("aircraft", true);
    }
  }, [snapshot?.layers.aircraft.enabled]);

  const resetTime = useCallback(() => {
    setNowTick(Date.now());
    changeTimeOffset(0);
  }, [changeTimeOffset]);

  const fetchKartaViewCoverage = useCallback(async () => {
    return fetchStreetPhotos(streetPoint.latitude, streetPoint.longitude);
  }, [streetPoint.latitude, streetPoint.longitude]);

  const openStreet = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || viewMode !== "earth" || streetChecking || streetOpen) return;
    const requestId = ++streetRequestRef.current;
    streetCameraPoseRef.current = runtime.captureCameraPose();
    setStreetChecking(true);
    setStreetNotice("Checking street imagery coverage…");
    setStreetIndex(0);
    setStreetPhotos([]);
    setGoogleStreetPanoId(null);
    setStreetError(undefined);

    let googleFallbackReason = "";
    // Start the keyless fallback immediately. Google may need to load its JS API
    // before it can even answer the coverage question; running KartaView beside it
    // prevents one blocked provider from serially delaying the second provider.
    const kartaCoveragePromise = fetchKartaViewCoverage()
      .then((photos) => ({ photos, error: null as string | null }))
      .catch((reason: unknown) => ({
        photos: [] as StreetPhoto[],
        error: reason instanceof Error ? reason.message : "KartaView unavailable",
      }));
    try {
      if (GOOGLE_MAPS_API_KEY) {
        try {
          const coverage = await findGoogleStreetCoverage(GOOGLE_MAPS_API_KEY, streetPoint);
          if (streetRequestRef.current !== requestId) return;
          if (coverage) {
            setGoogleStreetPanoId(coverage.panoId);
            setStreetProvider("google");
            setStreetState("ready");
            runtime.setSceneActive(false);
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

      const karta = await kartaCoveragePromise;
      if (streetRequestRef.current !== requestId) return;
      if (karta.photos.length) {
        setStreetPhotos(karta.photos);
        setStreetProvider("kartaview");
        setStreetState("ready");
        runtime.setSceneActive(false);
        setStreetOpen(true);
        setMobilePanel("street");
        setStreetNotice(null);
        setStreetError(googleFallbackReason ? `${googleFallbackReason} · KartaView fallback active` : undefined);
        return;
      }
      const noCoverage = karta.error
        ? `Street imagery unavailable — staying on Globe`
        : "No street imagery nearby — staying on Globe";
      setStreetState("error");
      setStreetOpen(false);
      setMobilePanel("none");
      setStreetNotice(noCoverage);
      setStreetError([googleFallbackReason, karta.error, noCoverage].filter(Boolean).join(" · "));
      streetCameraPoseRef.current = null;
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [viewMode, streetChecking, streetOpen, streetPoint, fetchKartaViewCoverage]);

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
      setStreetError(undefined);
    } catch (reason: unknown) {
      if (streetRequestRef.current !== requestId) return;
      setStreetNotice("Google Street View unavailable · keeping current Street view");
      setStreetError(reason instanceof Error ? reason.message : "Google Street View unavailable");
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [streetChecking, streetPoint]);

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
      setStreetError(undefined);
    } catch (reason: unknown) {
      if (streetRequestRef.current !== requestId) return;
      setStreetNotice("KartaView unavailable · keeping current Street view");
      setStreetError(reason instanceof Error ? reason.message : "KartaView unavailable");
    } finally {
      if (streetRequestRef.current === requestId) setStreetChecking(false);
    }
  }, [streetChecking, streetPhotos.length, fetchKartaViewCoverage]);

  const closeStreet = useCallback(() => {
    streetRequestRef.current += 1;
    const runtime = runtimeRef.current;
    const pose = streetCameraPoseRef.current;
    setStreetOpen(false);
    setStreetChecking(false);
    setStreetNotice(null);
    setMobilePanel(selected ? "inspector" : "none");
    setViewMode("earth");
    runtime?.setSceneActive(true);
    window.requestAnimationFrame(() => runtime?.restoreCameraPose(pose));
    streetCameraPoseRef.current = null;
  }, [selected]);

  useEffect(() => {
    if (!streetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeStreet(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streetOpen, closeStreet]);

  useEffect(() => () => {
    routeRequestRef.current?.abort();
    runtimeRef.current?.cancelMapPointCapture();
  }, []);

  const addAnnotation = useCallback(() => {
    const label = window.prompt("Annotation label", "Marker");
    if (!label?.trim()) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAnnotations((current) => [...current, {
      id,
      latitude: annotationPoint.latitude,
      longitude: annotationPoint.longitude,
      label: label.trim().slice(0, 48),
    }]);
  }, [annotationPoint.latitude, annotationPoint.longitude]);

  const togglePanel = (panel: Exclude<MobilePanel, "none">) => setMobilePanel((current) => current === panel ? "none" : panel);
  const currentStreet = streetPhotos[streetIndex] ?? null;
  const aircraftAvailable = viewMode === "earth" && timeOffsetDays === 0;
  const layerStats = snapshot?.layers;

  return (
    <main className="shell">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css" />
      <Script
        src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js"
        strategy="afterInteractive"
        onLoad={() => setCesiumReady(true)}
        onReady={() => setCesiumReady(true)}
        onError={() => setRuntimeError("CesiumJS could not be loaded")}
      />

      <div ref={containerRef} className={`globe ${viewMode === "space" || streetOpen ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SolarSystemView planets={planets} sun={sun} onSelect={selectEntity} />}

      <header className="topbar glass">
        <div className="brand"><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" && !groundMode ? "active" : ""} onClick={flyEarth}>EARTH</button>
          <button className={viewMode === "earth" && groundMode ? "active" : ""} onClick={flyGround}>GROUND</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={flySpace}>SPACE</button>
        </div>
        <div className="statusRow">
          <span className="statusDot" />
          <span>{runtimeError ? "RUNTIME ERROR" : runtimeReady ? "SPATIAL RUNTIME · ONE VIEWER" : "STARTING RUNTIME"}</span>
        </div>
      </header>

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {layerStats ? <>
          <LayerToggle
            checked={layerStats.earthquakes.enabled}
            onChange={(value) => setLayerEnabled("earthquakes", value)}
            onRetry={() => retryLayer("earthquakes")}
            title="Earthquakes"
            subtitle="USGS · atomic snapshot + last-good"
            state={toLoadState(layerStats.earthquakes.state)}
            count={layerStats.earthquakes.count}
            disabled={viewMode !== "earth"}
            error={layerStats.earthquakes.error ?? undefined}
          />
          <LayerToggle
            checked={layerStats.satellites.enabled}
            onChange={(value) => setLayerEnabled("satellites", value)}
            onRetry={() => retryLayer("satellites")}
            title="Satellites"
            subtitle={`CelesTrak · ${satelliteCatalog.toUpperCase()} · shared SGP4 clock`}
            state={toLoadState(layerStats.satellites.state)}
            count={layerStats.satellites.count}
            disabled={viewMode !== "earth"}
            error={layerStats.satellites.error ?? undefined}
          />
          {layerStats.satellites.enabled && <div className="satelliteCatalogSwitch" role="group" aria-label="Satellite catalog">
            <button className={satelliteCatalog === "core" ? "active" : ""} onClick={() => changeSatelliteCatalog("core")}>CORE</button>
            <button className={satelliteCatalog === "dense" ? "active" : ""} onClick={() => changeSatelliteCatalog("dense")}>DENSE</button>
          </div>}
          <LayerToggle
            checked={layerStats.aircraft.enabled}
            onChange={(value) => setLayerEnabled("aircraft", value)}
            onRetry={() => retryLayer("aircraft")}
            title="Aircraft"
            subtitle={aircraftAvailable
              ? `ADS-B · ${layerStats.aircraft.provenance?.provider ?? "provider resolving"} · ${layerStats.aircraft.provenance?.coverage ?? "coverage resolving"}`
              : "NOW only"}
            state={toLoadState(layerStats.aircraft.state)}
            count={aircraftAvailable ? layerStats.aircraft.count : 0}
            disabled={!aircraftAvailable}
            error={layerStats.aircraft.error ?? undefined}
          />
          {layerStats.aircraft.enabled && <div className="aircraftFilterSwitch" role="group" aria-label="Aircraft filter">
            <button className={aircraftFilter === "all" ? "active" : ""} onClick={() => changeAircraftFilter("all")}>ALL</button>
            <button className={aircraftFilter === "civilian" ? "active" : ""} onClick={() => changeAircraftFilter("civilian")}>CIV</button>
            <button className={aircraftFilter === "military" ? "active" : ""} onClick={() => changeAircraftFilter("military")}>MIL</button>
          </div>}
          <LayerToggle
            checked={layerStats.traffic.enabled}
            onChange={(value) => setLayerEnabled("traffic", value)}
            onRetry={() => retryLayer("traffic")}
            title="Traffic"
            subtitle="TomTom · viewport-driven imagery · independent failure"
            state={toLoadState(layerStats.traffic.state)}
            count={layerStats.traffic.visibleCount}
            disabled={viewMode !== "earth"}
            error={layerStats.traffic.error ?? undefined}
          />
          <div className={`directionsCard ${routeState === "error" ? "layerError" : ""}`}>
            <div className="directionsHead"><span><strong>Directions</strong><small>OSM / OSRM · keyless route + camera flythrough</small></span><b>{routeState === "routing" ? "…" : routeState === "ready" ? "READY" : ""}</b></div>
            <div className="directionsModes" role="group" aria-label="Route mode">
              <button className={routeMode === "foot" ? "active" : ""} onClick={() => changeRouteMode("foot")}>WALK</button>
              <button className={routeMode === "car" ? "active" : ""} onClick={() => changeRouteMode("car")}>DRIVE</button>
              <button className={routeMode === "bike" ? "active" : ""} onClick={() => changeRouteMode("bike")}>BIKE</button>
            </div>
            <div className="directionsActions">
              <button className={routeArm === "a" ? "active" : ""} onClick={() => armRoutePoint("a")} disabled={viewMode !== "earth"}>{routeArm === "a" ? "CLICK MAP" : routeA ? "A ✓" : "SET A"}</button>
              <button className={routeArm === "b" ? "active" : ""} onClick={() => armRoutePoint("b")} disabled={viewMode !== "earth"}>{routeArm === "b" ? "CLICK MAP" : routeB ? "B ✓" : "SET B"}</button>
              <button onClick={() => routeResult && runtimeRef.current?.flyRoute(routeResult)} disabled={!routeResult || routeState === "routing"}>FLY</button>
              <button onClick={clearRoute} disabled={!routeA && !routeB && !routeResult}>CLEAR</button>
            </div>
            {routeResult && <div className="directionsSummary">{formatDistance(routeResult.distanceM)} · {formatDuration(routeResult.durationS)} · {routeMode.toUpperCase()}</div>}
            {routeState === "routing" && <div className="directionsSummary">Routing on the street network…</div>}
            {routeError && <div className="directionsError">{routeError}</div>}
          </div>
        </> : <div className="emptyState"><p>{runtimeError ?? "Starting persistent spatial runtime…"}</p></div>}
        <div className="spaceLayerSummary">
          <span>Viewer</span><em>{runtimeReady ? "PERSISTENT" : "STARTING"}</em>
          <span>Map stack</span><em>{snapshot?.mapSource ?? "INITIALIZING"}</em>
          <span>Ground</span><em>SAME CESIUM SCENE</em>
          <span>Space</span><em>SUN + 8 PLANETS</em>
          <span>Google</span><em>NO BOOT-TIME MAP LOAD</em>
          <span>Street</span><em>ON-DEMAND ONLY</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {selected
          ? <Inspector
              entity={selected}
              onFocus={focusSelected}
              onStreet={openStreet}
              onAnnotate={addAnnotation}
              followAircraft={Boolean(snapshot?.followAircraft)}
              onToggleFollow={() => runtimeRef.current?.setFollowAircraft(!snapshot?.followAircraft)}
            />
          : <div className="emptyState"><div className="reticle">+</div><p>Select an earthquake, satellite, aircraft or planet.</p><div className="emptyActions"><button className="streetButton" onClick={openStreet} disabled={viewMode !== "earth"}>Open street level here</button><button className="annotationButton" onClick={addAnnotation} disabled={viewMode !== "earth"}>Mark this location</button></div></div>}
      </section>

      <section className={`timebar glass ${mobilePanel === "time" ? "mobileOpen" : ""}`}>
        <button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button>
        <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(event: ChangeEvent<HTMLInputElement>) => changeTimeOffset(Number(event.target.value))} />
        <div className="timeActions"><span>{timeOffsetDays > 0 ? `+${timeOffsetDays}` : timeOffsetDays} days</span><button onClick={resetTime}>NOW</button></div>
      </section>

      {!streetOpen && hovered?.kind === "satellite" && /(^|\s)ISS(\s|$)|ZARYA/i.test(hovered.name) && <IssLiveHoverCard
        entity={hovered}
        screen={snapshot?.hoveredScreen ?? null}
      />}

      {streetNotice && <div className="streetNotice" role="status">{streetNotice}</div>}
      {streetOpen && <StreetViewer
        provider={streetProvider}
        googleApiKey={GOOGLE_MAPS_API_KEY}
        googlePanoId={googleStreetPanoId}
        state={streetState}
        photo={currentStreet}
        index={streetIndex}
        total={streetPhotos.length}
        error={streetError}
        point={streetPoint}
        onClose={closeStreet}
        onUseGoogle={useGoogleStreet}
        onUseKartaView={useKartaViewStreet}
        onPrevious={() => setStreetIndex((index) => Math.max(0, index - 1))}
        onNext={() => setStreetIndex((index) => Math.min(streetPhotos.length - 1, index + 1))}
      />}

      <nav className="mobileDock glass" aria-label="Mobile controls">
        <button className={mobilePanel === "layers" ? "active" : ""} onClick={() => togglePanel("layers")}>Layers</button>
        <button className={mobilePanel === "inspector" ? "active" : ""} onClick={() => togglePanel("inspector")}>Inspect</button>
        <button className={mobilePanel === "street" ? "active" : ""} onClick={openStreet} disabled={viewMode !== "earth"}>Street</button>
        <button className={mobilePanel === "time" ? "active" : ""} onClick={() => togglePanel("time")}>Time</button>
      </nav>

      <footer className="legend glass">
        <span><i className="legendDot observed" /> OBSERVED</span><span><i className="legendDot calculated" /> CALCULATED</span>
        <span>Earth · Ground · Orbit · Solar System</span>
        <span>persistent viewer · global/local provider scopes · keyless default map stack</span>
      </footer>
    </main>
  );
}

function LayerToggle({ checked, onChange, onRetry, title, subtitle, state, count, disabled = false, error }: { checked: boolean; onChange: (value: boolean) => void; onRetry: () => void; title: string; subtitle: string; state: LoadState; count?: number; disabled?: boolean; error?: string }) {
  const effectiveState: LoadState | "off" = checked ? state : "off";
  const statusText = effectiveState === "off" ? "Off"
    : effectiveState === "loading" ? "Loading…"
    : effectiveState === "ready" ? (count ? `Live · ${count}` : "Live")
    : effectiveState === "degraded" ? (count ? `Degraded · ${count}` : "Degraded")
    : effectiveState === "error" ? "Unavailable" : "Ready to load";
  return <div className={`layerCard ${disabled ? "disabled" : ""} ${effectiveState === "error" ? "layerError" : ""} ${effectiveState === "degraded" ? "layerDegraded" : ""}`}>
    <label className="layerRow">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
      <span><strong>{title}</strong><small>{subtitle}</small></span><b>{checked && count ? count : ""}</b>
    </label>
    <div className={`layerLoadBar state-${effectiveState}`} aria-label={`${title} ${statusText}`}><i /></div>
    <div className="layerStatusLine">
      <span>{statusText}</span>
      {effectiveState === "loading" && <small>{error ?? "Fetching layer data…"}</small>}
      {effectiveState === "ready" && <small>Active with other runtime layers</small>}
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
  else if (entity.kind === "aircraft") {
    const origin = entity.properties.originAirport ?? entity.properties.origin;
    const destination = entity.properties.destinationAirport ?? entity.properties.destination;
    const route = origin && destination ? `${origin} → ${destination}` : "Not available from current ADS-B source";
    rows.push(
      ["Callsign", entity.name],
      ["ICAO24", String(entity.properties.hex ?? "—").toUpperCase()],
      ["Provider", String(entity.properties.provider ?? "—")],
      ["Coverage", String(entity.properties.coverage ?? "—")],
      ["Class", String(entity.properties.aircraftClass ?? "—")],
      ["Military", entity.properties.military ? "YES" : "NO"],
      ["Registration", String(entity.properties.registration ?? "—")],
      ["Type", String(entity.properties.aircraftType ?? "—")],
      ["Route", route],
      ["Altitude", `${entity.properties.altitudeFt ?? "—"} ft`],
      ["Speed", `${entity.properties.groundSpeedKt ?? "—"} kt`],
      ["Track", `${entity.properties.trackDeg ?? "—"}°`],
      ["Squawk", String(entity.properties.squawk ?? "—")],
      ["Emergency", String(entity.properties.emergency ?? "none")],
      ["Last seen", entity.properties.seenSeconds != null ? `${entity.properties.seenSeconds}s ago` : "—"],
      ["Motion", String(entity.properties.lodContract ?? entity.properties.renderModel ?? "—")],
    );
  } else if (entity.kind === "celestial-body") { rows.push(["Distance", `${entity.properties.heliocentricDistanceAu ?? 0} AU`]); if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]); }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button>{entity.kind === "aircraft" && <button className="followButton" onClick={onToggleFollow}>{followAircraft ? "Stop follow" : "Follow aircraft"}</button>}<button className="streetButton" onClick={onStreet}>Street near entity</button><button className="annotationButton" onClick={onAnnotate}>Mark location</button></div>}</>;
}

function IssLiveHoverCard({ entity, screen }: { entity: SpatialEntity; screen: { x: number; y: number } | null }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const timer = window.setTimeout(() => setReady(true), 500);
    return () => window.clearTimeout(timer);
  }, [entity.id]);
  const left = screen ? `min(${Math.max(12, screen.x + 18)}px, calc(100vw - 340px))` : "calc(50vw - 160px)";
  const top = screen ? `min(${Math.max(90, screen.y + 18)}px, calc(100vh - 245px))` : "120px";
  return <aside className="issLiveHover glass" style={{ left, top }} aria-label="ISS live video preview">
    <div className="issLiveHead"><span><b>ISS · LIVE 4K</b><small>Sen SpaceTV-1 · muted preview</small></span><em>LIVE</em></div>
    <div className="issLiveFrame">
      {ready
        ? <iframe
            src={`https://www.youtube-nocookie.com/embed/${SEN_ISS_LIVE_VIDEO_ID}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`}
            title="Sen live 4K video from the ISS"
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        : <div className="issLiveLoading">Hold on ISS to start live video…</div>}
    </div>
    <div className="issLiveMeta"><span>{entity.name}</span><a href="https://www.sen.com/live" target="_blank" rel="noreferrer">Open Sen live ↗</a></div>
  </aside>;
}

function StreetViewer({ provider, googleApiKey, googlePanoId, state, photo, index, total, error, point, onClose, onPrevious, onNext, onUseGoogle, onUseKartaView }: { provider: StreetProvider; googleApiKey: string; googlePanoId: string | null; state: LoadState; photo: StreetPhoto | null; index: number; total: number; error?: string; point: EarthPoint; onClose: () => void; onPrevious: () => void; onNext: () => void; onUseGoogle: () => void; onUseKartaView: () => void }) {
  return <section className="streetViewer glass" aria-label="Street-level imagery">
    <div className="streetHead"><div><p className="panelLabel">GROUND / STREET · {provider === "google" ? "GOOGLE STREET VIEW" : "KARTAVIEW"}</p><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong></div><button className="backToGlobe" type="button" onClick={onClose}>← Back to Globe</button></div>
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
  const points = planets.map((planet) => { const orbitRadius = radiusForAu(planet.radiusAu); const angle = Math.atan2(planet.yAu, planet.xAu); return { ...planet, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius }; });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((planet) => <g key={planet.entity.id} className="planetGroup" onClick={() => onSelect(planet.entity)}><circle cx={planet.px} cy={planet.py} r={planet.entity.name === "Earth" ? 9 : planet.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${planet.entity.name.toLowerCase()}`} /><text x={planet.px + 13} y={planet.py - 10} className="planetLabel">{planet.entity.name}</text></g>)}</svg></div>;
}
