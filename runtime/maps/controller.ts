const ESRI_WORLD_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_BOUNDARIES_PLACES = 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TILES = 'https://tile.openstreetmap.org/';

const TILE_FAILURE_THRESHOLD = 2;

export type MapSourceKind = 'esri-imagery' | 'osm' | 'google-3d' | 'initializing';

type MapStackOptions = {
  googleMapsApiKey?: string;
  cesiumIonToken?: string;
};

export class MapStackController {
  private Cesium: any;
  private viewer: any;
  private destroyed = false;
  private ownedLayers: any[] = [];
  private ownedPrimitiveCollections: any[] = [];
  private source = 'initializing';
  private sourceKind: MapSourceKind = 'initializing';
  private error: string | null = null;
  private onChanged: () => void;
  private tileFailureCount = 0;
  private tileFailureListener: (() => void) | null = null;
  private failedOverToOsm = false;
  private generation = 0;
  private google3DTileset: any = null;
  private readonly googleKey: string;
  private readonly ionToken: string;

  constructor(Cesium: any, viewer: any, googleKey: string, onChanged: () => void, options?: MapStackOptions) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.onChanged = onChanged;
    this.googleKey = options?.googleMapsApiKey ?? googleKey ?? '';
    this.ionToken = options?.cesiumIonToken ?? '';
  }

  getStatus() {
    return { source: this.source, error: this.error };
  }

  getSourceKind() { return this.sourceKind; }

  isGoogle3DActive() { return this.google3DTileset != null; }

  isGoogle3DAvailable() { return Boolean(this.googleKey); }

  private clearLayers() {
    for (const layer of this.ownedLayers) {
      try { this.viewer.imageryLayers.remove(layer, true); } catch { /* already removed */ }
    }
    this.ownedLayers = [];
  }

  private clearPrimitiveCollections() {
    for (const col of this.ownedPrimitiveCollections) {
      try { this.viewer.scene.primitives.remove(col); } catch { /* already removed */ }
    }
    this.ownedPrimitiveCollections = [];
    if (this.google3DTileset) {
      try { this.viewer.scene.primitives.remove(this.google3DTileset); } catch { /* already removed */ }
      this.google3DTileset = null;
    }
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

    const onTileError = () => {
      if (this.destroyed || this.failedOverToOsm) return;
      this.tileFailureCount++;
      if (this.tileFailureCount >= TILE_FAILURE_THRESHOLD) {
        this.failedOverToOsm = true;
        this.clearLayers();
        const osm = new this.Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES });
        this.addLayer(osm, 0);
        this.source = 'OpenStreetMap (runtime fallback) · keyless';
        this.sourceKind = 'osm';
        this.error = null;
        this.onChanged();
        this.viewer.scene.requestRender?.();
      }
    };

    for (let i = 0; i < this.viewer.imageryLayers.length; i++) {
      const layer = this.viewer.imageryLayers.get(i);
      if (this.ownedLayers.includes(layer) && layer.imageryProvider) {
        try {
          layer.imageryProvider.errorEvent?.addEventListener(() => onTileError());
        } catch { /* already subscribed or unsupported */ }
      }
    }

    this.tileFailureListener = onTileError;
  }

  async initialize() {
    const gen = ++this.generation;
    this.clearLayers();
    this.clearPrimitiveCollections();
    this.error = null;

    if (this.googleKey) {
      try {
        const tileset = await this.loadGoogle3DTiles(gen);
        if (this.destroyed || gen !== this.generation) return;
        this.google3DTileset = tileset;
        this.sourceKind = 'google-3d';
        this.source = 'Google Photorealistic 3D Tiles';
        this.onChanged();
        this.viewer.scene.requestRender?.();
        return;
      } catch (reason: unknown) {
        if (this.destroyed || gen !== this.generation) return;
        this.error = reason instanceof Error ? reason.message : 'Google 3D Tiles unavailable';
      }
    }

    try {
      const imagery = await this.Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY);
      if (this.destroyed || gen !== this.generation) return;
      this.addLayer(imagery, 0);
      try {
        const reference = await this.Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_BOUNDARIES_PLACES);
        if (!this.destroyed && gen === this.generation) {
          const labelLayer = this.addLayer(reference);
          labelLayer.alpha = 0.9;
        }
      } catch {
        // Imagery remains useful even if the reference overlay is unavailable.
      }
      if (this.destroyed || gen !== this.generation) return;
      this.source = 'Esri World Imagery + reference overlay · keyless';
      this.sourceKind = 'esri-imagery';
      this.installTileFailureListener();
      this.onChanged();
      this.viewer.scene.requestRender?.();
      return;
    } catch (reason: unknown) {
      if (this.destroyed || gen !== this.generation) return;
      this.error = reason instanceof Error ? reason.message : 'Esri imagery unavailable';
      this.clearLayers();
    }

    if (this.destroyed || gen !== this.generation) return;
    const osm = new this.Cesium.OpenStreetMapImageryProvider({ url: OSM_TILES });
    this.addLayer(osm, 0);
    this.source = 'OpenStreetMap fallback · keyless';
    this.sourceKind = 'osm';
    this.onChanged();
    this.viewer.scene.requestRender?.();
  }

  private async loadGoogle3DTiles(gen: number): Promise<any> {
    const resource = new this.Cesium.Resource({
      url: 'https://tile.googleapis.com/v1/3dtiles/root.json',
      queryParameters: { key: this.googleKey },
    });
    const tileset = await this.Cesium.Google3DTileset.fromUrl(resource);
    if (this.destroyed || gen !== this.generation) return tileset;
    this.viewer.scene.primitives.add(tileset);
    this.ownedPrimitiveCollections.push(tileset);
    return tileset;
  }

  async enableGoogle3D(): Promise<boolean> {
    if (!this.googleKey) return false;
    if (this.google3DTileset) return true;
    const gen = ++this.generation;
    try {
      const tileset = await this.loadGoogle3DTiles(gen);
      if (this.destroyed || gen !== this.generation) return false;
      this.google3DTileset = tileset;
      this.sourceKind = 'google-3d';
      this.source = 'Google Photorealistic 3D Tiles';
      this.onChanged();
      this.viewer.scene.requestRender?.();
      return true;
    } catch {
      return false;
    }
  }

  disableGoogle3D() {
    if (!this.google3DTileset) return;
    this.clearPrimitiveCollections();
    this.sourceKind = 'esri-imagery';
    this.source = 'Esri World Imagery + reference overlay · keyless';
    this.onChanged();
    this.viewer.scene.requestRender?.();
  }

  destroy() {
    this.destroyed = true;
    this.removeTileFailureListener();
    this.clearLayers();
    this.clearPrimitiveCollections();
  }
}
