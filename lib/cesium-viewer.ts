import { GEO_LABELS_EN } from '@/lib/geo-labels';

const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_WORLD_STREET = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';
const GROUND_BASEMAP_HEIGHT_M = 650_000;

export type ViewerLifecycle = {
  viewer: any;
  destroy: () => void;
};

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

  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#020617');
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000) });

  // Earth uses imagery; Ground switches to a road/city basemap so the user can
  // actually navigate at city/street scale. OSM is still the keyless fallback.
  let earthLayer: any = null;
  let groundLayer: any = null;
  const applyBasemapMode = (height: number) => {
    const ground = height < GROUND_BASEMAP_HEIGHT_M;
    if (earthLayer) earthLayer.show = !ground;
    if (groundLayer) groundLayer.show = ground;
  };

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      earthLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
      applyBasemapMode(viewer.camera.positionCartographic?.height ?? 9_500_000);
    })
    .catch(() => {
      if (viewer.isDestroyed()) return;
      earthLayer = viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES }), 0);
      applyBasemapMode(viewer.camera.positionCartographic?.height ?? 9_500_000);
    });

  void Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_STREET)
    .then((provider: any) => {
      if (viewer.isDestroyed()) return;
      groundLayer = viewer.imageryLayers.addImageryProvider(provider);
      applyBasemapMode(viewer.camera.positionCartographic?.height ?? 9_500_000);
    })
    .catch(() => {
      // Ground detail is an enhancement; Earth imagery remains usable if it fails.
      groundLayer = null;
    });

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
      applyBasemapMode(height);
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
    destroy: () => {
      viewer.camera.moveEnd.removeEventListener(updateView);
      handler.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}
