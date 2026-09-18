import { GEO_LABELS_DE } from '@/lib/geo-labels';

const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_WORLD_STREET = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer';
const ESRI_BOUNDARIES_PLACES = 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

export type GroundMapStyle = 'earth' | 'ground';
export type WorldMapMode = 'satellite' | 'map' | 'nasa';

export type ViewerLifecycle = {
  viewer: any;
  setMapStyle: (style: GroundMapStyle) => void;
  setMapMode: (mode: WorldMapMode) => void;
  setPhotorealistic3D: (enabled: boolean) => Promise<boolean>;
  destroy: () => void;
};

async function createTerrainProvider(Cesium: any): Promise<any> {
  try {
    return await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
  } catch {
    return new Cesium.EllipsoidTerrainProvider();
  }
}

export function createWorldViewer(input: {
  Cesium: any;
  container: HTMLElement;
  onViewChange: (view: { latitude: number; longitude: number; height: number }) => void;
  onEntityClick: (id: string) => void;
  onEntityHover?: (id: string | null, screen: { x: number; y: number } | null) => void;
  onEmptyClick?: (point: { latitude: number; longitude: number } | null) => void;
  googleMapsApiKey?: string;
}): ViewerLifecycle {
  const { Cesium, container, onViewChange, onEntityClick, onEntityHover, onEmptyClick, googleMapsApiKey = '' } = input;
  Cesium.Ion.defaultAccessToken = undefined;

  const viewer = new Cesium.Viewer(container, {
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
    baseLayer: false,
  });

  void createTerrainProvider(Cesium).then((tp) => {
    if (!viewer.isDestroyed()) viewer.terrainProvider = tp;
  });

  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#020617');
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000) });

  let requestedStyle: GroundMapStyle = 'earth';
  let requestedMode: WorldMapMode = 'satellite';
  let earthLayer: any = null;
  let groundLayer: any = null;
  let nasaLayer: any = null;
  let referenceLayer: any = null;
  let google3d: any = null;

  const applyStyle = () => {
    const in3d = Boolean(google3d);
    // NASA GIBS is an Earth-observation overlay, not a complete basemap.
    // Keep Esri World Imagery visible underneath so GIBS swath/no-data gaps
    // never cut holes through the globe.
    if (earthLayer) earthLayer.show = !in3d && (requestedMode === 'satellite' || requestedMode === 'nasa');
    if (groundLayer) groundLayer.show = !in3d && requestedMode === 'map';
    if (nasaLayer) nasaLayer.show = !in3d && requestedMode === 'nasa';
    if (referenceLayer) referenceLayer.show = !in3d && requestedMode !== 'map';
    viewer.scene.globe.show = !in3d;
    viewer.scene.requestRender?.();
  };

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      earthLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
      applyStyle();
    })
    .catch(() => {
      if (viewer.isDestroyed()) return;
      earthLayer = viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES }), 0);
      applyStyle();
    });

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_STREET)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      groundLayer = viewer.imageryLayers.addImageryProvider(provider);
      groundLayer.show = false;
      applyStyle();
    })
    .catch(() => { groundLayer = null; });

  try {
    const nasaDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const nasaProvider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/' + nasaDate + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
      minimumLevel: 0,
      maximumLevel: 9,
      credit: 'NASA EOSDIS GIBS / MODIS Terra',
    });
    nasaLayer = viewer.imageryLayers.addImageryProvider(nasaProvider);
    nasaLayer.show = false;
  } catch {
    nasaLayer = null;
  }

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_BOUNDARIES_PLACES)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      referenceLayer = viewer.imageryLayers.addImageryProvider(provider);
      referenceLayer.alpha = 0.9;
      applyStyle();
    })
    .catch(() => { referenceLayer = null; });

  for (const label of GEO_LABELS_DE) {
    viewer.entities.add({
      id: `geo-label:${label.id}`,
      position: Cesium.Cartesian3.fromDegrees(label.longitude, label.latitude, 0),
      label: {
        text: label.name,
        font: label.kind === 'country' ? '600 15px sans-serif' : label.kind === 'water' ? 'italic 13px sans-serif' : '600 12px sans-serif',
        fillColor: label.kind === 'water' ? Cesium.Color.fromCssColorString('#93c5fd') : Cesium.Color.fromCssColorString('#f8fafc'),
        outlineColor: Cesium.Color.fromCssColorString('#020617'),
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

  const updateView = () => {
    const canvas = viewer.scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const cartesian = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid);
    if (!cartesian) return;
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    const latitude = Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = Cesium.Math.toDegrees(cartographic.longitude);
    const height = viewer.camera.positionCartographic?.height;
    if ([latitude, longitude, height].every(Number.isFinite)) {
      onViewChange({ latitude, longitude, height });
    }
  };

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: any) => {
    const picked = viewer.scene.pick(movement.position);
    const id = picked?.id?.id;
    if (typeof id === 'string') {
      onEntityClick(id);
    } else {
      const ray = viewer.camera.getPickRay(movement.position);
      const terrainPoint = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
      const ellipsoidPoint = terrainPoint ?? viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
      if (!ellipsoidPoint) {
        onEmptyClick?.(null);
        return;
      }
      const cartographic = Cesium.Cartographic.fromCartesian(ellipsoidPoint);
      const latitude = Cesium.Math.toDegrees(cartographic.latitude);
      const longitude = Cesium.Math.toDegrees(cartographic.longitude);
      onEmptyClick?.(
        Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { latitude, longitude }
          : null,
      );
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((movement: any) => {
    if (!onEntityHover) return;
    const picked = viewer.scene.pick(movement.endPosition);
    const id = picked?.id?.id;
    if (typeof id === 'string') {
      onEntityHover(id, { x: Number(movement.endPosition?.x ?? 0), y: Number(movement.endPosition?.y ?? 0) });
    } else {
      onEntityHover(null, null);
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  viewer.camera.moveEnd.addEventListener(updateView);
  updateView();

  return {
    viewer,
    setMapStyle: (style: GroundMapStyle) => { requestedStyle = style; applyStyle(); },
    setMapMode: (mode: WorldMapMode) => { requestedMode = mode; applyStyle(); },
    setPhotorealistic3D: async (enabled: boolean) => {
      if (!enabled) {
        if (google3d) {
          try { viewer.scene.primitives.remove(google3d); } catch {}
          google3d = null;
        }
        applyStyle();
        return true;
      }
      if (!googleMapsApiKey) return false;
      if (google3d) return true;
      try {
        const resource = new Cesium.Resource({
          url: 'https://tile.googleapis.com/v1/3dtiles/root.json',
          queryParameters: { key: googleMapsApiKey },
        });
        google3d = await Cesium.Cesium3DTileset.fromUrl(resource);
        if (viewer.isDestroyed()) return false;
        viewer.scene.primitives.add(google3d);
        applyStyle();
        return true;
      } catch {
        google3d = null;
        applyStyle();
        return false;
      }
    },
    destroy: () => {
      viewer.camera.moveEnd.removeEventListener(updateView);
      handler.destroy();
      if (google3d) { try { viewer.scene.primitives.remove(google3d); } catch {} google3d = null; }
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}
