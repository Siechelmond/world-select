export class RenderGovernor {
  private viewer: any;
  private active = true;
  private destroyed = false;
  private pending = false;
  private visibilityHandler: (() => void) | null = null;

  constructor(viewer: any) {
    this.viewer = viewer;
    const scene = viewer.scene;
    scene.requestRenderMode = true;
    scene.maximumRenderTimeChange = Number.POSITIVE_INFINITY;

    if (typeof document !== 'undefined') {
      this.active = document.visibilityState !== 'hidden';
      this.visibilityHandler = () => {
        this.active = document.visibilityState !== 'hidden';
        if (this.active) this.request();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler, { passive: true });
    }
  }

  isActive() {
    return this.active && !this.destroyed;
  }

  setApplicationActive(active: boolean) {
    this.active = active && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    if (this.active) this.request();
  }

  request() {
    if (!this.isActive() || this.pending) return;
    this.pending = true;
    const flush = () => {
      this.pending = false;
      if (!this.isActive()) return;
      this.viewer.scene?.requestRender?.();
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }
}
