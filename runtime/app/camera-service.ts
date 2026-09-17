import type { CameraView } from '@/runtime/types';

export class CameraService {
  private Cesium: any;
  private viewer: any;
  private onView: (view: CameraView) => void;
  private lastMovingEmit = 0;
  private destroyed = false;

  private onChanged = () => {
    const now = performance.now();
    if (now - this.lastMovingEmit < 220) return;
    this.lastMovingEmit = now;
    const view = this.readView(true);
    if (view) this.onView(view);
  };

  private onMoveEnd = () => {
    const view = this.readView(false);
    if (view) this.onView(view);
  };

  constructor(Cesium: any, viewer: any, onView: (view: CameraView) => void) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.onView = onView;
    viewer.camera.changed.addEventListener(this.onChanged);
    viewer.camera.moveEnd.addEventListener(this.onMoveEnd);
    const initial = this.readView(false);
    if (initial) this.onView(initial);
  }

  readView(moving = false): CameraView | null {
    const canvas = this.viewer.scene.canvas;
    const center = new this.Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const cartesian = this.viewer.camera.pickEllipsoid(center, this.viewer.scene.globe.ellipsoid);
    const height = this.viewer.camera.positionCartographic?.height;
    if (!cartesian || !Number.isFinite(height)) return null;
    const cartographic = this.Cesium.Cartographic.fromCartesian(cartesian);
    const latitude = this.Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = this.Cesium.Math.toDegrees(cartographic.longitude);
    if (![latitude, longitude].every(Number.isFinite)) return null;
    return { latitude, longitude, height, moving };
  }

  flyTo(latitude: number, longitude: number, height: number, pitchDegrees = -90, duration = 1.0) {
    this.viewer.camera.flyTo({
      destination: this.Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
      orientation: {
        heading: 0,
        pitch: this.Cesium.Math.toRadians(pitchDegrees),
        roll: 0,
      },
      duration,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewer.camera.changed.removeEventListener(this.onChanged);
    this.viewer.camera.moveEnd.removeEventListener(this.onMoveEnd);
  }
}
