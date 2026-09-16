"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationTles, propagateTles, type TleRecord } from "@/lib/celestrak";
import { fetchAircraftNear } from "@/lib/aircraft";
import { fetchStreetPhotos, type StreetPhoto } from "@/lib/street";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";

declare global { interface Window { Cesium?: any } }

type LoadState = "idle" | "loading" | "ready" | "error";
type ViewMode = "earth" | "space";
type MobilePanel = "none" | "layers" | "inspector" | "time" | "street";
type EarthPoint = { latitude: number; longitude: number };
type LayerError = { earthquakes?: string; satellites?: string; aircraft?: string; street?: string };

const DAY_MS = 86_400_000;
const SATELLITE_TICK_MS = 1_000;
const AIRCRAFT_REFRESH_MS = 15_000;
const INITIAL_CENTER: EarthPoint = { latitude: 48.2082, longitude: 16.3738 };

export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const entityMapRef = useRef(new Map<string, SpatialEntity>());
  const quakeIdsRef = useRef(new Set<string>());
  const satIdsRef = useRef(new Set<string>());
  const aircraftIdsRef = useRef(new Set<string>());

  const [cesiumReady, setCesiumReady] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [tleRecords, setTleRecords] = useState<TleRecord[]>([]);
  const [aircraft, setAircraft] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(true);
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [aircraftLayer, setAircraftLayer] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [earthquakeState, setEarthquakeState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [aircraftState, setAircraftState] = useState<LoadState>("idle");
  const [viewCenter, setViewCenter] = useState<EarthPoint>(INITIAL_CENTER);
  const [selected, setSelected] = useState<SpatialEntity | null>(null);
  const [timeOffsetDays, setTimeOffsetDays] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [layerErrors, setLayerErrors] = useState<LayerError>({});
  const [streetPhotos, setStreetPhotos] = useState<StreetPhoto[]>([]);
  const [streetIndex, setStreetIndex] = useState(0);
  const [streetState, setStreetState] = useState<LoadState>("idle");
  const [streetOpen, setStreetOpen] = useState(false);

  const selectedTime = useMemo(
    () => new Date((timeOffsetDays === 0 ? nowTick : Date.now()) + timeOffsetDays * DAY_MS),
    [timeOffsetDays, nowTick],
  );
  const satellites = useMemo(() => propagateTles(tleRecords, selectedTime), [tleRecords, selectedTime]);
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);
  const aircraftAvailable = viewMode === "earth" && timeOffsetDays === 0;
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
    if (!satelliteLayer || timeOffsetDays !== 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), SATELLITE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [satelliteLayer, timeOffsetDays]);

  useEffect(() => {
    const controller = new AbortController();
    setEarthquakeState("loading");
    fetchEarthquakes(controller.signal)
      .then((items) => { setEarthquakes(items); setEarthquakeState("ready"); setLayerError("earthquakes"); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setEarthquakeState("error");
        setLayerError("earthquakes", reason instanceof Error ? reason.message : "USGS feed error");
      });
    return () => controller.abort();
  }, [setLayerError]);

  useEffect(() => {
    if (!satelliteLayer) return;
    const controller = new AbortController();
    setSatelliteState("loading");
    fetchStationTles(controller.signal)
      .then((records) => {
        setTleRecords(records);
        setSatelliteState(records.length ? "ready" : "error");
        setLayerError("satellites", records.length ? undefined : "CelesTrak returned no station elements");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setSatelliteState("error");
        setLayerError("satellites", reason instanceof Error ? reason.message : "Satellite feed error");
      });
    return () => controller.abort();
  }, [satelliteLayer, setLayerError]);

  useEffect(() => {
    if (!aircraftLayer || !aircraftAvailable) {
      if (!aircraftAvailable) setAircraft([]);
      return;
    }
    let disposed = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      setAircraftState("loading");
      try {
        const items = await fetchAircraftNear({ latitude: viewCenter.latitude, longitude: viewCenter.longitude, radiusNm: 250 }, controller.signal);
        if (disposed) return;
        setAircraft(items);
        setAircraftState("ready");
        setLayerError("aircraft", items.length ? undefined : "No ADS-B aircraft returned within 250 NM of the current view");
      } catch (reason: unknown) {
        if (controller.signal.aborted || disposed) return;
        setAircraftState("error");
        setLayerError("aircraft", reason instanceof Error ? reason.message : "Aircraft feed error");
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, AIRCRAFT_REFRESH_MS);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); };
  }, [aircraftLayer, aircraftAvailable, viewCenter.latitude, viewCenter.longitude, setLayerError]);

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

    const updateViewCenter = () => {
      const canvas = viewer.scene.canvas;
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const cartesian = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid);
      if (!cartesian) return;
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const latitude = Cesium.Math.toDegrees(cartographic.latitude);
      const longitude = Cesium.Math.toDegrees(cartographic.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) setViewCenter({ latitude, longitude });
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
      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(position);
      } else {
        satIdsRef.current.add(spatial.id);
        viewer.entities.add({
          id: spatial.id, position,
          point: { pixelSize: 8, color: Cesium.Color.fromCssColorString("#67e8f9"), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
          label: {
            text: spatial.name.includes("ISS") || spatial.name.includes("TIANHE") ? spatial.name : "",
            font: "11px sans-serif", fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(10, -10),
          },
        });
      }
    }
    for (const id of Array.from(satIdsRef.current)) {
      if (!liveIds.has(id)) { viewer.entities.removeById(id); entityMapRef.current.delete(id); satIdsRef.current.delete(id); }
    }
  }, [satellites, satelliteLayer, viewMode, clearIds, cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current; const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    clearIds(aircraftIdsRef.current);
    if (viewMode !== "earth" || !aircraftLayer || !aircraftAvailable) return;
    for (const spatial of aircraft) {
      entityMapRef.current.set(spatial.id, spatial); aircraftIdsRef.current.add(spatial.id);
      const speed = Number(spatial.properties.groundSpeedKt ?? 0);
      viewer.entities.add({
        id: spatial.id,
        position: Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, spatial.position.altitudeMeters),
        point: { pixelSize: speed > 250 ? 8 : 6, color: Cesium.Color.fromCssColorString("#facc15"), outlineColor: Cesium.Color.fromCssColorString("#fef9c3"), outlineWidth: 1 },
        label: {
          text: spatial.name, font: "10px sans-serif", fillColor: Cesium.Color.fromCssColorString("#fef08a"),
          pixelOffset: new Cesium.Cartesian2(9, -9), showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#111827").withAlpha(0.55),
        },
      });
    }
  }, [aircraft, aircraftLayer, aircraftAvailable, viewMode, clearIds, cesiumReady]);

  useEffect(() => {
    if (viewMode === "earth") return;
    clearIds(quakeIdsRef.current); clearIds(satIdsRef.current); clearIds(aircraftIdsRef.current);
  }, [viewMode, clearIds]);

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
          <button className={viewMode === "earth" ? "active" : ""} onClick={() => setViewMode("earth")}>EARTH</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={() => setViewMode("space")}>SPACE</button>
        </div>
        <div className="statusRow"><span className="statusDot" /><span>v3.1 STABILIZED</span></div>
      </header>

      <aside className={`layers glass ${mobilePanel === "layers" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">LAYERS</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        <LayerToggle checked={earthquakeLayer} onChange={setEarthquakeLayer} title="Earthquakes" subtitle={layerErrors.earthquakes ?? `USGS · ${earthquakeState}`} count={earthquakes.length} disabled={viewMode !== "earth"} error={!!layerErrors.earthquakes} />
        <LayerToggle checked={satelliteLayer} onChange={setSatelliteLayer} title="Satellites" subtitle={layerErrors.satellites ?? `CelesTrak + SGP4 · ${satelliteState} · 1s motion`} count={satellites.length} disabled={viewMode !== "earth"} error={!!layerErrors.satellites} />
        <LayerToggle checked={aircraftLayer} onChange={setAircraftLayer} title="Aircraft" subtitle={layerErrors.aircraft ?? (aircraftAvailable ? `ADSB.lol · ${aircraftState} · 15s refresh` : "Live layer · NOW only")} count={aircraftAvailable ? aircraft.length : 0} disabled={!aircraftAvailable} error={!!layerErrors.aircraft} />
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "SPACE"}</em>
          <span>Street level</span><em>KARTAVIEW IN-APP</em>
          <span>API bridge</span><em>CLOUDFLARE</em>
        </div>
      </aside>

      <section className={`inspector glass ${mobilePanel === "inspector" ? "mobileOpen" : ""}`}>
        <div className="panelHead"><p className="panelLabel">INSPECTOR</p><button className="sheetClose" onClick={() => setMobilePanel("none")}>×</button></div>
        {selected
          ? <Inspector entity={selected} onFocus={focusSelected} onStreet={openStreet} />
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
        <span>Earth · Orbit · Solar System</span><span>v3.1 · proxied live sources</span>
      </footer>
    </main>
  );
}

function LayerToggle({ checked, onChange, title, subtitle, count, disabled = false, error = false }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle: string; count: number; disabled?: boolean; error?: boolean }) {
  return <label className={`layerRow ${disabled ? "disabled" : ""} ${error ? "layerError" : ""}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span><strong>{title}</strong><small>{subtitle}</small></span><b>{count}</b></label>;
}

function Inspector({ entity, onFocus, onStreet }: { entity: SpatialEntity; onFocus: () => void; onStreet: () => void }) {
  const rows: Array<[string, string]> = [];
  if (entity.kind === "earthquake") rows.push(["Magnitude", String(entity.properties.magnitude ?? "—")], ["Depth", `${entity.properties.depthKm ?? "—"} km`]);
  else if (entity.kind === "satellite") rows.push(["NORAD", String(entity.properties.noradCatalogNumber ?? "—")], ["Altitude", `${entity.properties.altitudeKm ?? "—"} km`], ["Propagation", String(entity.properties.propagation ?? "—")]);
  else if (entity.kind === "aircraft") rows.push(["Registration", String(entity.properties.registration ?? "—")], ["Type", String(entity.properties.aircraftType ?? "—")], ["Altitude", `${entity.properties.altitudeFt ?? "—"} ft`], ["Speed", `${entity.properties.groundSpeedKt ?? "—"} kt`], ["Track", `${entity.properties.trackDeg ?? "—"}°`], ["Squawk", String(entity.properties.squawk ?? "—")]);
  else if (entity.kind === "celestial-body") { rows.push(["Distance", `${entity.properties.heliocentricDistanceAu ?? 0} AU`]); if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]); }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <div className="inspectorActions"><button className="focusButton" onClick={onFocus}>Focus entity</button><button className="streetButton" onClick={onStreet}>Street level</button></div>}</>;
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
