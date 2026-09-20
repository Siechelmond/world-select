export type GroundMapStyle = "earth" | "ground";
export type WorldMapMode = "photoreal" | "satellite" | "map" | "nasa";

const ESRI_WORLD_IMAGERY = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_WORLD_STREET = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer";
const OSM_TILES = "https://tile.openstreetmap.org/";
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";
const PHOTOREAL_READY_TIMEOUT_MS = 15_000;
const PHOTOREAL_RUNTIME_FAILURE_THRESHOLD = 3;

export type MapSwitchResult = Readonly<{
  requestedMode: WorldMapMode;
  activeMode: WorldMapMode;
  ok: boolean;
  route: "google-direct" | "google-ion" | "globe";
  error: string | null;
}>;

export type MapController = {
  setStyle: (style: GroundMapStyle) => void;
  setMode: (mode: WorldMapMode) => Promise<MapSwitchResult>;
  destroy: () => void;
  getState: () => Readonly<{
    style: GroundMapStyle;
    requestedMode: WorldMapMode;
    activeMode: WorldMapMode;
    switching: boolean;
    lastError: string | null;
  }>;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error ?? "Unknown map provider error");
}

function describeTileFailure(error: any) {
  const message = clean(error?.message || error?.url || error || "unknown tile failure");
  return message || "unknown tile failure";
}

function fatalTileFailure(message: string) {
  return /\b(401|403|429)\b|api.?key|billing|quota|denied|forbidden|unauthori/i.test(message);
}

function listenCesiumEvent(event: any, listener: (...args: any[]) => void) {
  if (!event?.addEventListener) return () => {};
  const remove = event.addEventListener(listener);
  if (typeof remove === "function") return remove;
  return () => {
    try { event.removeEventListener?.(listener); } catch {}
  };
}

export function createMapController(input: {
  viewer: any;
  Cesium: any;
  googleMapsApiKey?: string;
  cesiumIonToken?: string;
  onRuntimeFallback?: (error: string) => void;
}): MapController {
  const {
    viewer,
    Cesium,
    googleMapsApiKey = "",
    cesiumIonToken = "",
    onRuntimeFallback = () => {},
  } = input;

  let requestedStyle: GroundMapStyle = "earth";
  let requestedMode: WorldMapMode = "satellite";
  let activeMode: WorldMapMode = "satellite";
  let earthLayer: any = null;
  let groundLayer: any = null;
  let nasaLayer: any = null;
  let google3d: any = null;
  let google3dRoute: "google-direct" | "google-ion" | null = null;
  let google3dLoad: Promise<{ tileset: any; route: "google-direct" | "google-ion" }> | null = null;
  let google3dHealthy = false;
  let google3dRuntimeCleanup: (() => void) | null = null;
  let cancelPhotorealWait: (() => void) | null = null;
  let switchGeneration = 0;
  let switching = false;
  let lastError: string | null = null;
  let destroyed = false;

  const apply = () => {
    if (destroyed || viewer.isDestroyed?.()) return;
    const in3d = activeMode === "photoreal" && Boolean(google3d);
    const loading3d = switching && requestedMode === "photoreal" && Boolean(google3d);
    if (google3d) google3d.show = in3d || loading3d;
    // Satellite imagery remains underneath photoreal 3D as an immediate,
    // geographically correct fallback while Google tiles refine. This avoids
    // the multi-minute "holes over a dark globe" failure mode.
    if (earthLayer) earthLayer.show = activeMode === "photoreal" || activeMode === "satellite" || activeMode === "nasa";
    if (groundLayer) groundLayer.show = !in3d && activeMode === "map";
    if (nasaLayer) nasaLayer.show = !in3d && activeMode === "nasa";
    // Keep globe + terrain beneath Google photoreal tiles. Coverage quality is
    // not uniform worldwide, and ground-classified layers need a stable surface.
    if (viewer.scene?.globe) viewer.scene.globe.show = true;
    viewer.scene?.requestRender?.();
  };

  void Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL)
    .then((terrain: any) => {
      if (!destroyed && !viewer.isDestroyed?.()) {
        viewer.terrainProvider = terrain;
        viewer.scene?.requestRender?.();
      }
    })
    .catch(() => {});

  const addProvider = async (promise: Promise<any>, index?: number) => {
    const provider = await promise;
    if (destroyed || viewer.isDestroyed?.()) return null;
    return index == null
      ? viewer.imageryLayers.addImageryProvider(provider)
      : viewer.imageryLayers.addImageryProvider(provider, index);
  };

  void addProvider(Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY), 0)
    .then((layer) => {
      if (!layer) return;
      earthLayer = layer;
      apply();
    })
    .catch(() => {
      if (destroyed || viewer.isDestroyed?.()) return;
      earthLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES }),
        0,
      );
      apply();
    });

  void addProvider(Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_STREET))
    .then((layer) => {
      if (!layer) return;
      groundLayer = layer;
      apply();
    })
    .catch(() => { groundLayer = null; });

  try {
    const provider = new Cesium.WebMapServiceImageryProvider({
      url: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
      layers: "BlueMarble_NextGeneration",
      parameters: {
        service: "WMS",
        version: "1.1.1",
        transparent: "false",
        format: "image/jpeg",
      },
      tilingScheme: new Cesium.GeographicTilingScheme(),
      credit: "NASA EOSDIS GIBS / Blue Marble Next Generation",
    });
    nasaLayer = viewer.imageryLayers.addImageryProvider(provider);
    nasaLayer.alpha = 1;
    nasaLayer.brightness = 1;
    nasaLayer.contrast = 1;
    nasaLayer.saturation = 1;
    nasaLayer.show = false;
  } catch {
    nasaLayer = null;
  }

  const createDirectGoogleTileset = async () => {
    const key = clean(googleMapsApiKey);
    if (!key) throw new Error("Google 3D requires an explicit browser key");
    if (typeof Cesium.createGooglePhotorealistic3DTileset !== "function") {
      throw new Error("This Cesium runtime does not expose the Google Photorealistic 3D helper");
    }
    return Cesium.createGooglePhotorealistic3DTileset({
      key,
      onlyUsingWithGoogleGeocoder: true,
    });
  };

  const createIonGoogleTileset = async () => {
    const token = clean(cesiumIonToken);
    if (!token) throw new Error("NEXT_PUBLIC_CESIUM_ION_TOKEN is not configured");
    if (!Cesium.IonResource?.fromAssetId || !Cesium.Cesium3DTileset?.fromUrl) {
      throw new Error("This Cesium runtime does not expose the ion 3D Tiles path");
    }
    const resource = await Cesium.IonResource.fromAssetId(2275207, { accessToken: token });
    return Cesium.Cesium3DTileset.fromUrl(resource, {
      cacheBytes: 1536 * 1024 * 1024,
      maximumCacheOverflowBytes: 1024 * 1024 * 1024,
      enableCollision: true,
    });
  };

  const configurePhotorealistic = (tileset: any) => {
    tileset.maximumScreenSpaceError = 24;
    if ("dynamicScreenSpaceError" in tileset) tileset.dynamicScreenSpaceError = true;
    if ("preloadWhenHidden" in tileset) tileset.preloadWhenHidden = false;
    if ("preloadFlightDestinations" in tileset) tileset.preloadFlightDestinations = false;
    if ("cullRequestsWhileMoving" in tileset) tileset.cullRequestsWhileMoving = true;
    tileset.show = false;
  };

  const clearRuntimeHealth = () => {
    google3dRuntimeCleanup?.();
    google3dRuntimeCleanup = null;
  };

  const discardPhotorealistic = (tileset: any) => {
    clearRuntimeHealth();
    if (google3d === tileset) {
      google3d = null;
      google3dRoute = null;
      google3dHealthy = false;
    }
    try { tileset.show = false; } catch {}
    try {
      if (!viewer.scene.primitives.remove(tileset)) tileset.destroy?.();
    } catch {
      try { tileset.destroy?.(); } catch {}
    }
  };

  const ensurePhotorealistic = async (preferredRoute?: "google-direct" | "google-ion") => {
    if (google3d && google3dRoute && (!preferredRoute || google3dRoute === preferredRoute)) {
      return { tileset: google3d, route: google3dRoute };
    }
    if (google3dLoad) return google3dLoad;

    google3dLoad = (async () => {
      const errors: string[] = [];
      const attempts: Array<"google-direct" | "google-ion"> = preferredRoute
        ? [preferredRoute]
        : [
            ...(clean(googleMapsApiKey) ? ["google-direct" as const] : []),
            ...(clean(cesiumIonToken) ? ["google-ion" as const] : []),
          ];

      if (!attempts.length) {
        throw new Error("No Google Maps browser key or Cesium ion fallback token is configured");
      }

      for (const route of attempts) {
        try {
          const tileset = route === "google-direct"
            ? await createDirectGoogleTileset()
            : await createIonGoogleTileset();
          return { tileset, route };
        } catch (error) {
          errors.push(`${route}: ${describeError(error)}`);
        }
      }
      throw new Error(errors.join(" | "));
    })();

    const load = google3dLoad;
    try {
      const loaded = await load;
      if (destroyed || viewer.isDestroyed?.()) {
        try { loaded.tileset.destroy?.(); } catch {}
        throw new Error("Viewer was destroyed while Google 3D was loading");
      }
      if (!google3d) {
        configurePhotorealistic(loaded.tileset);
        viewer.scene.primitives.add(loaded.tileset);
        google3d = loaded.tileset;
        google3dRoute = loaded.route;
        google3dHealthy = false;
      } else if (loaded.tileset !== google3d) {
        try { loaded.tileset.destroy?.(); } catch {}
      }
      return { tileset: google3d, route: google3dRoute! };
    } finally {
      if (google3dLoad === load) google3dLoad = null;
    }
  };

  const waitForUsefulPhotorealistic = (
    tileset: any,
    route: "google-direct" | "google-ion",
    generation: number,
  ) => new Promise<void>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    const removers: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      for (const remove of removers.splice(0)) {
        try { remove(); } catch {}
      }
      if (timer != null) clearTimeout(timer);
      if (cancelPhotorealWait === cancel) cancelPhotorealWait = null;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(new Error("Map switch was superseded"));

    cancelPhotorealWait = cancel;
    removers.push(listenCesiumEvent(tileset.tileVisible, () => {
      if (generation !== switchGeneration) {
        cancel();
        return;
      }
      finish();
    }));
    removers.push(listenCesiumEvent(tileset.tileLoad, () => {
      viewer.scene?.requestRender?.();
    }));
    removers.push(listenCesiumEvent(tileset.loadProgress, () => {
      viewer.scene?.requestRender?.();
    }));
    removers.push(listenCesiumEvent(tileset.tileFailed, (error: any) => {
      if (generation !== switchGeneration) {
        cancel();
        return;
      }
      failures += 1;
      const detail = describeTileFailure(error);
      if (fatalTileFailure(detail) || failures >= PHOTOREAL_RUNTIME_FAILURE_THRESHOLD) {
        finish(new Error(`${route} tile delivery failed: ${detail}`));
      }
    }));

    timer = setTimeout(
      () => finish(new Error(`${route} did not produce a visible 3D tile within ${PHOTOREAL_READY_TIMEOUT_MS / 1000} seconds`)),
      PHOTOREAL_READY_TIMEOUT_MS,
    );
    tileset.show = true;
    viewer.scene?.requestRender?.();
  });

  const installRuntimeHealth = (tileset: any, route: "google-direct" | "google-ion") => {
    clearRuntimeHealth();
    let failures = 0;
    const removeVisible = listenCesiumEvent(tileset.tileVisible, () => {
      failures = 0;
    });
    const removeFailed = listenCesiumEvent(tileset.tileFailed, (error: any) => {
      if (destroyed || google3d !== tileset || activeMode !== "photoreal") return;
      failures += 1;
      const detail = describeTileFailure(error);
      if (!fatalTileFailure(detail) && failures < PHOTOREAL_RUNTIME_FAILURE_THRESHOLD) return;

      const message = `Google Photorealistic 3D runtime failed (${route}: ${detail}); using SAT`;
      lastError = message;
      requestedMode = "satellite";
      activeMode = "satellite";
      switching = false;
      switchGeneration += 1;
      discardPhotorealistic(tileset);
      apply();
      try { onRuntimeFallback(message); } catch {}
    });
    google3dRuntimeCleanup = () => {
      try { removeVisible(); } catch {}
      try { removeFailed(); } catch {}
    };
  };

  const result = (ok: boolean, route: MapSwitchResult["route"], error: string | null): MapSwitchResult =>
    Object.freeze({ requestedMode, activeMode, ok, route, error });

  return Object.freeze({
    setStyle(style: GroundMapStyle) {
      requestedStyle = style;
      apply();
    },

    async setMode(mode: WorldMapMode) {
      if (destroyed || viewer.isDestroyed?.()) {
        return result(false, "globe", "Map controller is unavailable");
      }
      requestedMode = mode;
      lastError = null;
      const generation = ++switchGeneration;
      cancelPhotorealWait?.();
      switching = true;

      if (mode !== "photoreal") {
        activeMode = mode;
        switching = false;
        apply();
        return result(true, "globe", null);
      }

      try {
        let loaded = await ensurePhotorealistic();
        if (generation !== switchGeneration || destroyed || viewer.isDestroyed?.()) {
          return result(false, "globe", "Map switch was superseded");
        }

        if (!google3dHealthy) {
          try {
            await waitForUsefulPhotorealistic(loaded.tileset, loaded.route, generation);
          } catch (firstError) {
            if (generation !== switchGeneration) {
              return result(false, "globe", "Map switch was superseded");
            }
            const firstMessage = `${loaded.route} runtime: ${describeError(firstError)}`;
            const canRecoverThroughIon = loaded.route === "google-direct" && Boolean(clean(cesiumIonToken));
            discardPhotorealistic(loaded.tileset);

            if (!canRecoverThroughIon) throw new Error(firstMessage);
            try {
              loaded = await ensurePhotorealistic("google-ion");
              await waitForUsefulPhotorealistic(loaded.tileset, loaded.route, generation);
            } catch (ionError) {
              if (google3d && !google3dHealthy) discardPhotorealistic(google3d);
              throw new Error(`${firstMessage} | google-ion runtime: ${describeError(ionError)}`);
            }
          }
        } else {
          loaded.tileset.show = true;
          viewer.scene?.requestRender?.();
        }

        if (generation !== switchGeneration || destroyed || viewer.isDestroyed?.()) {
          return result(false, "globe", "Map switch was superseded");
        }
        google3dHealthy = true;
        activeMode = "photoreal";
        switching = false;
        apply();
        installRuntimeHealth(loaded.tileset, loaded.route);
        return result(true, loaded.route, null);
      } catch (error) {
        if (generation !== switchGeneration) {
          return result(false, "globe", "Map switch was superseded");
        }
        if (google3d && !google3dHealthy) discardPhotorealistic(google3d);
        lastError = describeError(error);
        activeMode = "satellite";
        switching = false;
        apply();
        return result(false, "globe", lastError);
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      switchGeneration += 1;
      cancelPhotorealWait?.();
      cancelPhotorealWait = null;
      clearRuntimeHealth();
      google3dLoad = null;
      if (google3d) {
        try {
          if (!viewer.scene.primitives.remove(google3d)) google3d.destroy?.();
        } catch {
          try { google3d.destroy?.(); } catch {}
        }
        google3d = null;
        google3dRoute = null;
        google3dHealthy = false;
      }
      for (const layer of [nasaLayer, groundLayer, earthLayer]) {
        if (!layer) continue;
        try { viewer.imageryLayers.remove(layer, true); } catch {}
      }
      nasaLayer = null;
      groundLayer = null;
      earthLayer = null;
    },

    getState() {
      return Object.freeze({
        style: requestedStyle,
        requestedMode,
        activeMode,
        switching,
        lastError,
      });
    },
  });
}
