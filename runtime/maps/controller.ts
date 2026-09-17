const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_BOUNDARIES_PLACES = 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';

const TILE_FAILURE_THRESHOLD = 2;

export class MapStackController {
  private Cesium: any;
  private viewer: any;
  private destroyed = false;
  private ownedLayers: any[] = [];
  private source = 'initializing';
  private error: string | null = null;
  private onChanged: () => void;
  private tileFailureCount = 0;
  private tileFailureListener: (() => void) | null = null;
  private failedOverToOsm = false;

  constructor(Cesium: any, viewer: any, _googleKey: string, onChanged: () => void) {
    this.Cesium = Cesium;
    this.viewer = viewer;
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

  private removeTileFailureListener() {
    if (this.tileFailureListener) {
      this.viewer.scene.globe.tileLoadProgressEvent?.removeEventListener(this.tileFailureListener);
      this.tileFailureListener = null;
    }
  }

  private installTileFailureListener() {
    this.removeTileFailureListener();
    this.tileFailureCount = 0;
    this.failedOverToOsm = false;

    const imageryLayers = this.viewer.imageryLayers;
    const onTileError = () => {
      if (this.destroyed || this.failedOverToOsm) return;
      this.tileFailureCount++;
      if (this.tileFailureCount >= TILE_FAILURE_THRESHOLD) {
        this.failedOverToOsm = true;
        this.clearLayers();
        const osm = new this.Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES });
        this.addLayer(osm, 0);
        this.source = 'OpenStreetMap (runtime fallback) · keyless';
        this.error = null;
        this.onChanged();
        this.viewer.scene.requestRender?.();
      }
    };

    if (imageryLayers.layerAdded) {
      const installErrorHandler = (_layer: any) => {
        for (let i = 0; i < imageryLayers.length; i++) {
          const layer = imageryLayers.get(i);
          if (this.ownedLayers.includes(layer) && layer.imageryProvider) {
            try {
              layer.imageryProvider.errorEvent?.addEventListener(() => onTileError());
            } catch { /* already subscribed or unsupported */ }
          }
        }
      };
      for (let i = 0; i < imageryLayers.length; i++) {
        installErrorHandler(imageryLayers.get(i));
      }
    }

    this.tileFailureListener = onTileError;
  }

  async initialize() {
    this.clearLayers();
    this.error = null;

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
      this.source = 'Esri World Imagery + reference overlay · keyless';
      this.installTileFailureListener();
      this.onChanged();
      this.viewer.scene.requestRender?.();
      return;
    } catch (reason: unknown) {
      this.error = reason instanceof Error ? reason.message : 'Esri imagery unavailable';
      this.clearLayers();
    }

    const osm = new this.Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES });
    this.addLayer(osm, 0);
    this.source = 'OpenStreetMap fallback · keyless';
    this.onChanged();
    this.viewer.scene.requestRender?.();
  }

  destroy() {
    this.destroyed = true;
    this.removeTileFailureListener();
    this.clearLayers();
  }
}
