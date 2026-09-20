export type GroundMapStyle = "earth" | "ground";
export type WorldMapMode = "photoreal" | "satellite" | "map" | "nasa";

const ESRI_WORLD_IMAGERY = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_WORLD_STREET = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer";
const OSM_TILES = "https://tile.openstreetmap.org/";
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

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
  let switchGeneration = 0;
  let switching = false;
  let lastError: string | null = null;
  let destroyed = false;

  const apply = () => {
    if (destroyed || viewer.isDestroyed?.()) return;
    const in3d = activeMode === "photoreal" && Boolean(google3d);
    if (google3d) google3d.show = in3d;
    // Google Photorealistic 3D owns the visual Earth surface while active.
    // Keeping the satellite raster visible underneath produces coarse patchwork
    // at orbital LOD boundaries as the Google mesh refines.
    if (earthLayer) earthLayer.show = !in3d && (activeMode === "satellite" || activeMode === "nasa");
    if (groundLayer) groundLayer.show = !in3d && activeMode === "map";
    if (nasaLayer) nasaLayer.show = !in3d && activeMode === "nasa";
    // ws-donor invariant: a 3D tileset is a map stack, not an overlay on the
    // Cesium globe. Terrain stays configured but the globe is hidden in 3D.
    if (viewer.scene?.globe) viewer.scene.globe.show = !in3d;
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
    if (!token) {
      throw new Error("NEXT_PUBLIC_CESIUM_ION_TOKEN is not configured");
    }

    // Direct ws-donor recovery route: explicit ion asset, no SDK-wide token
    // mutation and the same cache/collision defaults as the donor runtime.
    const resource = await Cesium.IonResource.fromAssetId(2275207, {
      accessToken: token,
    });
    return Cesium.Cesium3DTileset.fromUrl(resource, {
      cacheBytes: 1536 * 1024 * 1024,
      maximumCacheOverflowBytes: 1024 * 1024 * 1024,
      enableCollision: true,
    });
  };

  const ensurePhotorealistic = async () => {
    if (google3d && google3dRoute) return { tileset: google3d, route: google3dRoute };
    if (google3dLoad) return google3dLoad;

    google3dLoad = (async () => {
      const errors: string[] = [];
      if (clean(googleMapsApiKey)) {
        try {
          return { tileset: await createDirectGoogleTileset(), route: "google-direct" as const };
        } catch (error) {
          errors.push(`google-direct: ${describeError(error)}`);
        }
      }
      if (clean(cesiumIonToken)) {
        try {
          return { tileset: await createIonGoogleTileset(), route: "google-ion" as const };
        } catch (error) {
          errors.push(`google-ion: ${describeError(error)}`);
        }
      } else {
        errors.push("google-ion: NEXT_PUBLIC_CESIUM_ION_TOKEN is not configured");
      }
      if (!errors.length) errors.push("No Google Maps browser key or Cesium ion fallback token is configured");
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
        // ws-donor leaves Google/Cesium streaming and LOD defaults intact.
        loaded.tileset.show = false;
        viewer.scene.primitives.add(loaded.tileset);
        google3d = loaded.tileset;
        google3dRoute = loaded.route;
      } else if (loaded.tileset !== google3d) {
        try { loaded.tileset.destroy?.(); } catch {}
      }
      return { tileset: google3d, route: google3dRoute! };
    } finally {
      if (google3dLoad === load) google3dLoad = null;
    }
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
      switching = true;

      if (mode !== "photoreal") {
        activeMode = mode;
        switching = false;
        apply();
        return result(true, "globe", null);
      }

      try {
        const loaded = await ensurePhotorealistic();
        if (generation !== switchGeneration || destroyed || viewer.isDestroyed?.()) {
          return result(false, "globe", "Map switch was superseded");
        }
        activeMode = "photoreal";
        switching = false;
        apply();
        return result(true, loaded.route, null);
      } catch (error) {
        if (generation !== switchGeneration) {
          return result(false, "globe", "Map switch was superseded");
        }
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
      google3dLoad = null;
      if (google3d) {
        try {
          if (!viewer.scene.primitives.remove(google3d)) google3d.destroy?.();
        } catch {
          try { google3d.destroy?.(); } catch {}
        }
        google3d = null;
        google3dRoute = null;
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
