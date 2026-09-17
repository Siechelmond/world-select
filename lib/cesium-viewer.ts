import { GEO_LABELS_EN } from '@/lib/geo-labels';

const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_WORLD_STREET = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer';
const ESRI_BOUNDARIES_PLACES = 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

export type GroundMapStyle = 'earth' | 'ground';

export type ViewerLifecycle = {
  viewer: any;
  setMapStyle: (style: GroundMapStyle) => void;
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
}): ViewerLifecycle {
  const { Cesium, container, onViewChange, onEntityClick } = input;
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
  let earthLayer: any = null;
  let groundLayer: any = null;
  let referenceLayer: any = null;

  const applyStyle = () => {
    const wantsGround = requestedStyle === 'ground';
    if (earthLayer) earthLayer.show = !wantsGround || !groundLayer;
    if (groundLayer) groundLayer.show = wantsGround;
    if (referenceLayer) referenceLayer.show = !wantsGround;
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

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_BOUNDARIES_PLACES)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      referenceLayer = viewer.imageryLayers.addImageryProvider(provider);
      referenceLayer.alpha = 0.9;
      applyStyle();
    })
    .catch(() => { referenceLayer = null; });

  for (const label of GEO_LABELS_EN) {
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
    if (typeof id === 'string') onEntityClick(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  viewer.camera.moveEnd.addEventListener(updateView);
  updateView();

  return {
    viewer,
    setMapStyle: (style: GroundMapStyle) => { requestedStyle = style; applyStyle(); },
    destroy: () => {
      viewer.camera.moveEnd.removeEventListener(updateView);
      handler.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}
