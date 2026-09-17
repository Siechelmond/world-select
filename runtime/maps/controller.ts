const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_BOUNDARIES_PLACES = 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';

export class MapStackController {
  private Cesium: any;
  private viewer: any;
  private googleKey: string;
  private destroyed = false;
  private ownedLayers: any[] = [];
  private source = 'initializing';
  private error: string | null = null;
  private onChanged: () => void;

  constructor(Cesium: any, viewer: any, googleKey: string, onChanged: () => void) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.googleKey = googleKey;
    this.onChanged = onChanged;
  }

  getStatus() {
    return { source: this.source, error: this.error };
  }

  private clearLayers() {
    for (const layer of this.ownedLayers) {
      try { this.viewer.imageryLayers.remove(layer, true); } catch { /* already removed */ }
    }
    this.ownedLayers = [];
  }

  private addLayer(provider: any, index?: number) {
    const layer = index == null
      ? this.viewer.imageryLayers.addImageryProvider(provider)
      : this.viewer.imageryLayers.addImageryProvider(provider, index);
    this.ownedLayers.push(layer);
    return layer;
  }

  async initialize() {
    this.clearLayers();
    this.error = null;

    if (this.googleKey && this.Cesium.Google2DImageryProvider?.fromUrl) {
      try {
        this.Cesium.GoogleMaps.defaultApiKey = this.googleKey;
        const imagery = await this.Cesium.Google2DImageryProvider.fromUrl({
          key: this.googleKey,
          mapType: 'satellite',
          language: 'en-US',
          region: 'AT',
        });
        if (this.destroyed) return;
        this.addLayer(imagery, 0);

        const labels = await this.Cesium.Google2DImageryProvider.fromUrl({
          key: this.googleKey,
          overlayLayerType: 'layerRoadmap',
          language: 'en-US',
          region: 'AT',
        });
        if (this.destroyed) return;
        const labelLayer = this.addLayer(labels);
        labelLayer.alpha = 0.94;
        this.source = 'Google 2D satellite + English roadmap overlay';
        this.onChanged();
        this.viewer.scene.requestRender?.();
        return;
      } catch (reason: unknown) {
        this.error = reason instanceof Error ? reason.message : 'Google Map Tiles unavailable';
        this.clearLayers();
      }
    }

    try {
      const imagery = await this.Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY);
      if (this.destroyed) return;
      this.addLayer(imagery, 0);
      try {
        const reference = await this.Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_BOUNDARIES_PLACES);
        if (!this.destroyed) {
          const labelLayer = this.addLayer(reference);
          labelLayer.alpha = 0.9;
        }
      } catch {
        // Imagery remains useful even if the reference overlay is unavailable.
      }
      this.source = 'Esri World Imagery + reference overlay';
      this.onChanged();
      this.viewer.scene.requestRender?.();
      return;
    } catch (reason: unknown) {
      this.error = reason instanceof Error ? reason.message : 'Esri imagery unavailable';
      this.clearLayers();
    }

    const osm = new this.Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES });
    this.addLayer(osm, 0);
    this.source = 'OpenStreetMap fallback';
    this.onChanged();
    this.viewer.scene.requestRender?.();
  }

  destroy() {
    this.destroyed = true;
    this.clearLayers();
  }
}
