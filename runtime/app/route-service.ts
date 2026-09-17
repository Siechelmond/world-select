import type { RoutePoint, RouteResult } from '@/lib/directions';

export class RouteService {
  private Cesium: any;
  private viewer: any;
  private requestRender: () => void;
  private routeEntity: any = null;
  private markerA: any = null;
  private markerB: any = null;
  private frame: number | null = null;
  private destroyed = false;

  constructor(Cesium: any, viewer: any, requestRender: () => void) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.requestRender = requestRender;
  }

  showRoute(a: RoutePoint, b: RoutePoint, route: RouteResult) {
    this.clear(true);
    const positions = route.coordinates.map(([lon, lat]) => this.Cesium.Cartesian3.fromDegrees(lon, lat, 8));
    this.routeEntity = this.viewer.entities.add({
      id: '__world-select:route',
      polyline: {
        positions,
        width: 5,
        material: new this.Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          color: this.Cesium.Color.fromCssColorString('#39d0ff'),
        }),
        clampToGround: true,
      },
    });
    this.markerA = this.viewer.entities.add({
      id: '__world-select:route-a',
      position: this.Cesium.Cartesian3.fromDegrees(a.longitude, a.latitude, 12),
      point: { pixelSize: 11, color: this.Cesium.Color.fromCssColorString('#5dff9f'), outlineColor: this.Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: 'A', pixelOffset: new this.Cesium.Cartesian2(0, -18), fillColor: this.Cesium.Color.WHITE, showBackground: true, backgroundColor: this.Cesium.Color.BLACK.withAlpha(0.62) },
    });
    this.markerB = this.viewer.entities.add({
      id: '__world-select:route-b',
      position: this.Cesium.Cartesian3.fromDegrees(b.longitude, b.latitude, 12),
      point: { pixelSize: 11, color: this.Cesium.Color.fromCssColorString('#ff6b6b'), outlineColor: this.Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: 'B', pixelOffset: new this.Cesium.Cartesian2(0, -18), fillColor: this.Cesium.Color.WHITE, showBackground: true, backgroundColor: this.Cesium.Color.BLACK.withAlpha(0.62) },
    });
    this.requestRender();
  }

  fly(route: RouteResult) {
    this.stopFlight();
    const coordinates = route.coordinates;
    if (coordinates.length < 2 || this.destroyed) return;

    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
      const [lon1, lat1] = coordinates[i - 1];
      const [lon2, lat2] = coordinates[i];
      const a = this.Cesium.Cartesian3.fromDegrees(lon1, lat1, 0);
      const b = this.Cesium.Cartesian3.fromDegrees(lon2, lat2, 0);
      total += this.Cesium.Cartesian3.distance(a, b);
      cumulative.push(total);
    }
    if (!Number.isFinite(total) || total <= 0) return;

    const durationMs = Math.min(28_000, Math.max(8_000, total / 25));
    const started = performance.now();
    const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const render = (now: number) => {
      if (this.destroyed) return;
      const raw = Math.min(1, (now - started) / durationMs);
      const targetDistance = ease(raw) * total;
      let index = 1;
      while (index < cumulative.length - 1 && cumulative[index] < targetDistance) index += 1;
      const segmentStart = cumulative[index - 1];
      const segmentLength = Math.max(1, cumulative[index] - segmentStart);
      const local = Math.max(0, Math.min(1, (targetDistance - segmentStart) / segmentLength));
      const [lon1, lat1] = coordinates[index - 1];
      const [lon2, lat2] = coordinates[index];
      const longitude = lon1 + (lon2 - lon1) * local;
      const latitude = lat1 + (lat2 - lat1) * local;
      const heading = Math.atan2((lon2 - lon1) * Math.cos(latitude * Math.PI / 180), lat2 - lat1);
      const cameraHeight = total < 2_000 ? 110 : total < 20_000 ? 180 : 320;
      this.viewer.camera.setView({
        destination: this.Cesium.Cartesian3.fromDegrees(longitude, latitude, cameraHeight),
        orientation: {
          heading,
          pitch: this.Cesium.Math.toRadians(-48),
          roll: 0,
        },
      });
      this.requestRender();
      if (raw < 1) this.frame = requestAnimationFrame(render);
      else this.frame = null;
    };
    this.frame = requestAnimationFrame(render);
  }

  stopFlight() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  clear(removeMarkers = true) {
    this.stopFlight();
    if (this.routeEntity) this.viewer.entities.remove(this.routeEntity);
    this.routeEntity = null;
    if (removeMarkers) {
      if (this.markerA) this.viewer.entities.remove(this.markerA);
      if (this.markerB) this.viewer.entities.remove(this.markerB);
      this.markerA = null;
      this.markerB = null;
    }
    this.requestRender();
  }

  destroy() {
    this.destroyed = true;
    this.clear(true);
  }
}
