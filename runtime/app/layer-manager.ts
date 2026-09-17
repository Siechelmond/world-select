import type { SpatialEntity } from '@/lib/spatial';
import type { CameraView, RuntimeLayer, RuntimeLayerId, RuntimeLayerStats } from '@/runtime/types';

export class LayerManager {
  private layers = new Map<RuntimeLayerId, RuntimeLayer>();

  register(layer: RuntimeLayer) {
    if (this.layers.has(layer.id)) throw new Error(`Runtime layer already registered: ${layer.id}`);
    this.layers.set(layer.id, layer);
  }

  get<T extends RuntimeLayer = RuntimeLayer>(id: RuntimeLayerId): T {
    const layer = this.layers.get(id);
    if (!layer) throw new Error(`Runtime layer not registered: ${id}`);
    return layer as T;
  }

  async enable(id: RuntimeLayerId) { await this.get(id).enable(); }
  disable(id: RuntimeLayerId) { this.get(id).disable(); }
  async retry(id: RuntimeLayerId) { await this.get(id).retry(); }

  setSceneActive(active: boolean) {
    for (const layer of this.layers.values()) layer.setSceneActive(active);
  }

  onCameraChanged(view: CameraView) {
    for (const layer of this.layers.values()) layer.onCameraChanged(view);
  }

  select(entity: SpatialEntity | null) {
    for (const layer of this.layers.values()) {
      layer.select(entity && this.belongsToLayer(entity, layer.id) ? entity.id : null);
    }
  }

  private belongsToLayer(entity: SpatialEntity, id: RuntimeLayerId) {
    return (id === 'earthquakes' && entity.kind === 'earthquake')
      || (id === 'satellites' && entity.kind === 'satellite')
      || (id === 'aircraft' && entity.kind === 'aircraft');
  }

  resolveEntity(id: string): SpatialEntity | null {
    for (const layer of this.layers.values()) {
      const entity = layer.getEntity(id);
      if (entity) return entity;
    }
    return null;
  }

  stats(): Record<RuntimeLayerId, RuntimeLayerStats> {
    return {
      earthquakes: this.get('earthquakes').getStats(),
      satellites: this.get('satellites').getStats(),
      aircraft: this.get('aircraft').getStats(),
      traffic: this.get('traffic').getStats(),
    };
  }

  destroy() {
    for (const layer of this.layers.values()) layer.destroy();
    this.layers.clear();
  }
}
