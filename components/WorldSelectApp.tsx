"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationSatellites } from "@/lib/celestrak";
import { computePlanetPositions, sunEntity, type PlanetPosition } from "@/lib/space";

declare global {
  interface Window { Cesium?: any; }
}

type LoadState = "idle" | "loading" | "ready" | "error";
type ViewMode = "earth" | "space";

const DAY_MS = 86_400_000;

export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const entityMapRef = useRef(new Map<string, SpatialEntity>());
  const [cesiumReady, setCesiumReady] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [satellites, setSatellites] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(true);
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("earth");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [satelliteState, setSatelliteState] = useState<LoadState>("idle");
  const [selected, setSelected] = useState<SpatialEntity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeOffsetDays, setTimeOffsetDays] = useState(0);

  const selectedTime = useMemo(() => new Date(Date.now() + timeOffsetDays * DAY_MS), [timeOffsetDays]);
  const planets = useMemo(() => computePlanetPositions(selectedTime), [selectedTime]);
  const sun = useMemo(() => sunEntity(selectedTime), [selectedTime]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    fetchEarthquakes(controller.signal)
      .then((items) => { setEarthquakes(items); setLoadState("ready"); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState("error");
        setError(reason instanceof Error ? reason.message : "Unknown USGS feed error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSatelliteState("loading");
    fetchStationSatellites(selectedTime, controller.signal)
      .then((items) => { setSatellites(items); setSatelliteState("ready"); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setSatelliteState("error");
        setError(reason instanceof Error ? reason.message : "Unknown CelesTrak feed error");
      });
    return () => controller.abort();
  }, [selectedTime]);

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
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#020617");
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000) });
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: any) => {
      const picked = viewer.scene.pick(movement.position);
      const id = picked?.id?.id;
      if (typeof id === "string") {
        const spatial = entityMapRef.current.get(id);
        if (spatial) setSelected(spatial);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    viewerRef.current = viewer;
    return () => { handler.destroy(); viewer.destroy(); viewerRef.current = null; };
  }, [cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;
    viewer.entities.removeAll();
    entityMapRef.current.clear();
    if (viewMode !== "earth") return;

    if (earthquakeLayer) {
      for (const spatial of earthquakes) {
        const magnitude = Number(spatial.properties.magnitude ?? 0);
        entityMapRef.current.set(spatial.id, spatial);
        viewer.entities.add({
          id: spatial.id,
          position: Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, 0),
          point: {
            pixelSize: Math.max(7, Math.min(20, 5 + magnitude * 2)),
            color: Cesium.Color.fromCssColorString("#fb923c").withAlpha(0.88),
            outlineColor: Cesium.Color.fromCssColorString("#fff7ed"), outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    }

    if (satelliteLayer) {
      for (const spatial of satellites) {
        entityMapRef.current.set(spatial.id, spatial);
        viewer.entities.add({
          id: spatial.id,
          position: Cesium.Cartesian3.fromDegrees(spatial.position.longitude, spatial.position.latitude, spatial.position.altitudeMeters),
          point: {
            pixelSize: 8,
            color: Cesium.Color.fromCssColorString("#67e8f9"),
            outlineColor: Cesium.Color.fromCssColorString("#ecfeff"), outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: spatial.name.includes("ISS") || spatial.name.includes("TIANHE") ? spatial.name : "",
            font: "11px sans-serif", fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    }
  }, [earthquakes, satellites, earthquakeLayer, satelliteLayer, cesiumReady, viewMode]);

  const focusSelected = useCallback(() => {
    if (!selected || selected.kind === "celestial-body" || !viewerRef.current || !window.Cesium) return;
    const Cesium = window.Cesium;
    const altitude = selected.kind === "satellite" ? Math.max(800_000, selected.position.altitudeMeters * 2.8) : 700_000;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(selected.position.longitude, selected.position.latitude, altitude),
      duration: 1.2,
    });
  }, [selected]);

  const resetTime = () => setTimeOffsetDays(0);

  return (
    <main className="shell">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css" />
      <Script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js" strategy="afterInteractive" onLoad={() => setCesiumReady(true)} onError={() => setError("CesiumJS could not be loaded.")} />

      <div ref={containerRef} className={`globe ${viewMode === "space" ? "globeHidden" : ""}`} aria-label="Interactive 3D globe" />
      {viewMode === "space" && <SolarSystemView planets={planets} sun={sun} onSelect={setSelected} />}

      <header className="topbar glass">
        <div><p className="eyebrow">SPATIAL INTELLIGENCE</p><h1>World Select</h1></div>
        <div className="modeSwitch" role="group" aria-label="View mode">
          <button className={viewMode === "earth" ? "active" : ""} onClick={() => setViewMode("earth")}>EARTH</button>
          <button className={viewMode === "space" ? "active" : ""} onClick={() => setViewMode("space")}>SPACE</button>
        </div>
        <div className="statusRow"><span className={`statusDot ${loadState === "error" ? "bad" : ""}`} /><span>{loadState === "ready" ? "LIVE + CALCULATED" : loadState.toUpperCase()}</span></div>
      </header>

      <aside className="layers glass">
        <p className="panelLabel">LAYERS</p>
        <LayerToggle checked={earthquakeLayer} onChange={setEarthquakeLayer} title="Earthquakes" subtitle="USGS · M2.5+ · past day" count={earthquakes.length} disabled={viewMode !== "earth"} />
        <LayerToggle checked={satelliteLayer} onChange={setSatelliteLayer} title="Satellites" subtitle={`CelesTrak stations · ${satelliteState}`} count={satellites.length} disabled={viewMode !== "earth"} />
        <div className="spaceLayerSummary">
          <span>Sun + 8 planets</span><em>{viewMode === "space" ? "ACTIVE" : "SPACE"}</em>
          <span>Time model</span><em>JPL APPROX</em>
          <span>Traffic / Aircraft</span><em>NEXT</em>
        </div>
      </aside>

      <section className="inspector glass">
        <p className="panelLabel">INSPECTOR</p>
        {selected ? <Inspector entity={selected} onFocus={focusSelected} /> : <div className="emptyState"><div className="reticle">+</div><p>Select an earthquake, satellite or planet to inspect its normalized spatial record.</p></div>}
      </section>

      <section className="timebar glass">
        <div><p className="panelLabel">TIME</p><strong>{selectedTime.toLocaleString()}</strong></div>
        <input aria-label="Time offset in days" type="range" min={-365} max={365} step={1} value={timeOffsetDays} onChange={(e) => setTimeOffsetDays(Number(e.target.value))} />
        <div className="timeActions"><span>{timeOffsetDays > 0 ? `+${timeOffsetDays}` : timeOffsetDays} days</span><button onClick={resetTime}>NOW</button></div>
      </section>

      <footer className="legend glass">
        <span><i className="legendDot observed" /> OBSERVED</span>
        <span><i className="legendDot calculated" /> CALCULATED</span>
        <span>Earth · Orbit · Solar System</span>
        <span>No database · no secret key</span>
      </footer>
      {error && <div className="errorBanner" onClick={() => setError(null)}>{error}</div>}
    </main>
  );
}

function LayerToggle({ checked, onChange, title, subtitle, count, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle: string; count: number; disabled?: boolean }) {
  return <label className={`layerRow ${disabled ? "disabled" : ""}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span><strong>{title}</strong><small>{subtitle}</small></span><b>{count}</b></label>;
}

function Inspector({ entity, onFocus }: { entity: SpatialEntity; onFocus: () => void }) {
  const rows: Array<[string, string]> = [];
  if (entity.kind === "earthquake") {
    rows.push(["Magnitude", String(entity.properties.magnitude ?? "—")], ["Depth", `${entity.properties.depthKm ?? "—"} km`]);
  } else if (entity.kind === "satellite") {
    rows.push(["NORAD", String(entity.properties.noradCatalogNumber ?? "—")], ["Altitude", `${entity.properties.altitudeKm ?? "—"} km`], ["Propagation", String(entity.properties.propagation ?? "—")]);
  } else if (entity.kind === "celestial-body") {
    rows.push(["Distance", `${entity.properties.heliocentricDistanceAu ?? 0} AU`]);
    if (entity.properties.model) rows.push(["Model", String(entity.properties.model)]);
  }
  rows.push(["Time", new Date(entity.observedAt).toLocaleString()], ["State", entity.dataState], ["Source", entity.source.label]);
  return <><div className="entityHeading"><div className="kindBadge">{entity.kind}</div><h2>{entity.name}</h2></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "State" ? <span className="stateBadge">{value}</span> : value}</dd></div>)}</dl>{entity.kind !== "celestial-body" && <button className="focusButton" onClick={onFocus}>Focus entity</button>}</>;
}

function SolarSystemView({ planets, sun, onSelect }: { planets: PlanetPosition[]; sun: SpatialEntity; onSelect: (entity: SpatialEntity) => void }) {
  const size = 1000;
  const center = size / 2;
  const maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((p) => {
    const orbitRadius = radiusForAu(p.radiusAu);
    const angle = Math.atan2(p.yAu, p.xAu);
    return { ...p, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius };
  });
  return <div className="spaceScene"><div className="spaceTitle"><span>SOLAR SYSTEM</span><small>JPL approximate heliocentric positions · visual distances logarithmically scaled</small></div><svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions"><defs><radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient></defs>{[0.39,0.72,1,1.52,5.2,9.54,19.2,30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}<circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} /><circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/><text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>{points.map((p) => <g key={p.entity.id} className="planetGroup" onClick={() => onSelect(p.entity)}><circle cx={p.px} cy={p.py} r={p.entity.name === "Earth" ? 9 : p.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${p.entity.name.toLowerCase()}`} /><text x={p.px + 13} y={p.py - 10} className="planetLabel">{p.entity.name}</text></g>)}</svg></div>;
}
