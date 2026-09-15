"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import { fetchEarthquakes } from "@/lib/usgs";

declare global {
  interface Window {
    Cesium?: any;
  }
}

type LoadState = "idle" | "loading" | "ready" | "error";

export default function WorldSelectApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const entityMapRef = useRef(new Map<string, SpatialEntity>());
  const [cesiumReady, setCesiumReady] = useState(false);
  const [earthquakes, setEarthquakes] = useState<SpatialEntity[]>([]);
  const [earthquakeLayer, setEarthquakeLayer] = useState(true);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [selected, setSelected] = useState<SpatialEntity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");

    fetchEarthquakes(controller.signal)
      .then((items) => {
        setEarthquakes(items);
        setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState("error");
        setError(reason instanceof Error ? reason.message : "Unknown feed error");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!cesiumReady || !containerRef.current || !window.Cesium || viewerRef.current) return;

    const Cesium = window.Cesium;
    Cesium.Ion.defaultAccessToken = undefined;

    const viewer = new Cesium.Viewer(containerRef.current, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayer: new Cesium.ImageryLayer(
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://tile.openstreetmap.org/",
        })
      ),
    });

    viewer.scene.globe.enableLighting = true;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#020617");
    viewer.scene.skyBox.show = true;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000),
    });

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

    return () => {
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [cesiumReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium) return;

    viewer.entities.removeAll();
    entityMapRef.current.clear();

    if (!earthquakeLayer) return;

    for (const spatial of earthquakes) {
      const magnitude = Number(spatial.properties.magnitude ?? 0);
      const pointSize = Math.max(7, Math.min(20, 5 + magnitude * 2));
      const id = spatial.id;
      entityMapRef.current.set(id, spatial);

      viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(
          spatial.position.longitude,
          spatial.position.latitude,
          0
        ),
        point: {
          pixelSize: pointSize,
          color: Cesium.Color.fromCssColorString("#fb923c").withAlpha(0.88),
          outlineColor: Cesium.Color.fromCssColorString("#fff7ed"),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }, [earthquakes, earthquakeLayer, cesiumReady]);

  const focusSelected = useCallback(() => {
    if (!selected || !viewerRef.current || !window.Cesium) return;
    const Cesium = window.Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        selected.position.longitude,
        selected.position.latitude,
        700_000
      ),
      duration: 1.2,
    });
  }, [selected]);

  return (
    <main className="shell">
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css"
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js"
        strategy="afterInteractive"
        onLoad={() => setCesiumReady(true)}
        onError={() => {
          setError("CesiumJS could not be loaded.");
          setLoadState("error");
        }}
      />

      <div ref={containerRef} className="globe" aria-label="Interactive 3D globe" />

      <header className="topbar glass">
        <div>
          <p className="eyebrow">SPATIAL INTELLIGENCE</p>
          <h1>World Select</h1>
        </div>
        <div className="statusRow">
          <span className={`statusDot ${loadState === "error" ? "bad" : ""}`} />
          <span>{loadState === "ready" ? "LIVE PUBLIC FEED" : loadState.toUpperCase()}</span>
        </div>
      </header>

      <aside className="layers glass">
        <p className="panelLabel">LAYERS</p>
        <label className="layerRow">
          <input
            type="checkbox"
            checked={earthquakeLayer}
            onChange={(event) => setEarthquakeLayer(event.target.checked)}
          />
          <span>
            <strong>Earthquakes</strong>
            <small>USGS · M2.5+ · past day</small>
          </span>
          <b>{earthquakes.length}</b>
        </label>
        <div className="futureLayers">
          <span>Aircraft</span><em>NEXT</em>
          <span>Satellites</span><em>NEXT</em>
          <span>Traffic</span><em>LATER</em>
          <span>Space</span><em>LATER</em>
        </div>
      </aside>

      <section className="inspector glass">
        <p className="panelLabel">INSPECTOR</p>
        {selected ? (
          <>
            <div className="entityHeading">
              <div className="kindBadge">{selected.kind}</div>
              <h2>{selected.name}</h2>
            </div>
            <dl>
              <div><dt>Magnitude</dt><dd>{String(selected.properties.magnitude ?? "—")}</dd></div>
              <div><dt>Depth</dt><dd>{String(selected.properties.depthKm ?? "—")} km</dd></div>
              <div><dt>Observed</dt><dd>{new Date(selected.observedAt).toLocaleString()}</dd></div>
              <div><dt>State</dt><dd><span className="stateBadge">{selected.dataState}</span></dd></div>
              <div><dt>Position</dt><dd>{selected.position.latitude.toFixed(3)}°, {selected.position.longitude.toFixed(3)}°</dd></div>
              <div><dt>Source</dt><dd>{selected.source.label}</dd></div>
            </dl>
            <button className="focusButton" onClick={focusSelected}>Focus entity</button>
          </>
        ) : (
          <div className="emptyState">
            <div className="reticle">+</div>
            <p>Select an earthquake marker to inspect its normalized spatial record.</p>
          </div>
        )}
      </section>

      <footer className="legend glass">
        <span><i className="legendDot" /> OBSERVED</span>
        <span>Earth · Orbit · Space architecture</span>
        <span>No database · no secret key</span>
      </footer>

      {error && <div className="errorBanner">{error}</div>}
    </main>
  );
}
