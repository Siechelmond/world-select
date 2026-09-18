export type GroundMapStyle = "earth" | "ground";
export type WorldMapMode = "satellite" | "map" | "nasa";

const ESRI_WORLD_IMAGERY = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_WORLD_STREET = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer";
const ESRI_BOUNDARIES_PLACES = "https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer";
const OSM_TILES = "https://tile.openstreetmap.org/";
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

export type MapController = {
  setStyle: (style: GroundMapStyle) => void;
  setMode: (mode: WorldMapMode) => void;
  setPhotorealistic3D: (enabled: boolean) => Promise<boolean>;
  destroy: () => void;
  getState: () => Readonly<{
    style: GroundMapStyle;
    mode: WorldMapMode;
    photorealistic3D: boolean;
  }>;
};

/**
 * GEV-derived map ownership boundary. Basemap, reference overlays and 3D tiles
 * live here instead of being recreated by React effects or scattered viewer code.
 */
export function createMapController(input: {
  viewer: any;
  Cesium: any;
  googleMapsApiKey?: string;
}): MapController {
  const { viewer, Cesium, googleMapsApiKey = "" } = input;
  let requestedStyle: GroundMapStyle = "earth";
  let requestedMode: WorldMapMode = "satellite";
  let earthLayer: any = null;
  let groundLayer: any = null;
  let nasaLayer: any = null;
  let referenceLayer: any = null;
  let google3d: any = null;
  let destroyed = false;

  const apply = () => {
    if (destroyed || viewer.isDestroyed?.()) return;
    const in3d = Boolean(google3d);
    // NASA GIBS is an EO overlay, never the sole globe basemap.
    if (earthLayer) earthLayer.show = !in3d && (requestedMode === "satellite" || requestedMode === "nasa");
    if (groundLayer) groundLayer.show = !in3d && requestedMode === "map";
    if (nasaLayer) nasaLayer.show = !in3d && requestedMode === "nasa";
    if (referenceLayer) referenceLayer.show = !in3d && requestedMode !== "map";
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
    .catch(() => {
      // The viewer starts on ellipsoid terrain; keep it as the keyless fallback.
    });

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
      groundLayer.show = false;
      apply();
    })
    .catch(() => { groundLayer = null; });

  try {
    const nasaDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${nasaDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      minimumLevel: 0,
      maximumLevel: 9,
      credit: "NASA EOSDIS GIBS / MODIS Terra",
    });
    nasaLayer = viewer.imageryLayers.addImageryProvider(provider);
    nasaLayer.show = false;
  } catch {
    nasaLayer = null;
  }

  void addProvider(Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_BOUNDARIES_PLACES))
    .then((layer) => {
      if (!layer) return;
      referenceLayer = layer;
      referenceLayer.alpha = 0.9;
      apply();
    })
    .catch(() => { referenceLayer = null; });

  return Object.freeze({
    setStyle(style: GroundMapStyle) {
      requestedStyle = style;
      // Kept as an explicit state lane even though current source choice is mode-driven.
      // This prevents camera altitude from remounting the map stack.
      apply();
    },

    setMode(mode: WorldMapMode) {
      requestedMode = mode;
      apply();
    },

    async setPhotorealistic3D(enabled: boolean) {
      if (destroyed || viewer.isDestroyed?.()) return false;
      if (!enabled) {
        if (google3d) {
          try { viewer.scene.primitives.remove(google3d); } catch { /* already gone */ }
          google3d = null;
        }
        apply();
        return true;
      }
      if (!googleMapsApiKey) return false;
      if (google3d) return true;
      try {
        const resource = new Cesium.Resource({
          url: "https://tile.googleapis.com/v1/3dtiles/root.json",
          queryParameters: { key: googleMapsApiKey },
        });
        const tileset = await Cesium.Cesium3DTileset.fromUrl(resource);
        if (destroyed || viewer.isDestroyed?.()) {
          try { tileset.destroy?.(); } catch { /* no-op */ }
          return false;
        }
        google3d = tileset;
        viewer.scene.primitives.add(google3d);
        apply();
        return true;
      } catch {
        google3d = null;
        apply();
        return false;
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (google3d) {
        try { viewer.scene.primitives.remove(google3d); } catch { /* no-op */ }
        google3d = null;
      }
      for (const layer of [referenceLayer, nasaLayer, groundLayer, earthLayer]) {
        if (!layer) continue;
        try { viewer.imageryLayers.remove(layer, true); } catch { /* no-op */ }
      }
      referenceLayer = null;
      nasaLayer = null;
      groundLayer = null;
      earthLayer = null;
    },

    getState() {
      return Object.freeze({
        style: requestedStyle,
        mode: requestedMode,
        photorealistic3D: Boolean(google3d),
      });
    },
  });
}
