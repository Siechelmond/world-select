import { GEO_LABELS_DE } from '@/lib/geo-labels';
import { holdContinuousRender, installRenderGovernor, releaseContinuousRender, uninstallRenderGovernor } from '@/runtime/gev/render-governor';
import {
  createMapController,
  type GroundMapStyle,
  type MapSwitchResult,
  type WorldMapMode,
} from '@/runtime/gev/map-controller';

export type { GroundMapStyle, MapSwitchResult, WorldMapMode };

export type ViewerLifecycle = {
  viewer: any;
  setMapStyle: (style: GroundMapStyle) => void;
  setMapMode: (mode: WorldMapMode) => Promise<MapSwitchResult>;
  home: () => void;
  toggleTilt: () => void;
  northUp: () => void;
  flyTo: (point: { latitude: number; longitude: number; height?: number }) => void;
  destroy: () => void;
};

export function createWorldViewer(input: {
  Cesium: any;
  container: HTMLElement;
  onViewChange: (view: { latitude: number; longitude: number; height: number }) => void;
  onEntityClick: (id: string) => void;
  onEntityHover?: (id: string | null, screen: { x: number; y: number } | null) => void;
  onEmptyClick?: (point: { latitude: number; longitude: number } | null) => void;
  googleMapsApiKey?: string;
  cesiumIonToken?: string;
}): ViewerLifecycle {
  const {
    Cesium,
    container,
    onViewChange,
    onEntityClick,
    onEntityHover,
    onEmptyClick,
    googleMapsApiKey = '',
    cesiumIonToken = '',
  } = input;
  Cesium.Ion.defaultAccessToken = cesiumIonToken.trim() || undefined;

  const viewer = new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
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

  // Keep one Earth viewer usable from ground scale out to the outer planets.
  // Positions stay in real meters; logarithmic depth preserves precision across
  // the extreme near/far range without changing physical object coordinates.
  viewer.scene.logarithmicDepthBuffer = true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 6_000_000_000_000;
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.enableLook = true;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(14.2, 47.6, 9_500_000),
  });

  const mapController = createMapController({ viewer, Cesium, googleMapsApiKey, cesiumIonToken });
  installRenderGovernor(viewer);

  for (const label of GEO_LABELS_DE) {
    viewer.entities.add({
      id: `geo-label:${label.id}`,
      position: Cesium.Cartesian3.fromDegrees(label.longitude, label.latitude, 0),
      label: {
        text: label.name,
        font: label.kind === 'country'
          ? '600 13px "Segoe UI", Arial, sans-serif'
          : label.kind === 'water'
            ? 'italic 11px "Segoe UI", Arial, sans-serif'
            : '600 13px "Segoe UI", Arial, sans-serif',
        fillColor: label.kind === 'water'
          ? Cesium.Color.fromCssColorString('#93c5fd')
          : label.kind === 'country'
            ? Cesium.Color.fromCssColorString('#cbd5e1')
            : Cesium.Color.fromCssColorString('#f8fafc'),
        outlineColor: Cesium.Color.fromCssColorString('#020617'),
        outlineWidth: label.kind === 'city' ? 3 : 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(label.minHeight, label.maxHeight),
        translucencyByDistance: new Cesium.NearFarScalar(label.minHeight || 1, 1, label.maxHeight, label.kind === 'city' ? 0.72 : 0.5),
        disableDepthTestDistance: 0,
      },
    });
  }

  let lastGroundCenter = { latitude: 47.6, longitude: 14.2 };

  const pickGroundCenter = () => {
    const canvas = viewer.scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let hit: any = null;
    try {
      if (viewer.scene.pickPositionSupported) hit = viewer.scene.pickPosition(center);
    } catch {}
    if (!hit) {
      try {
        const ray = viewer.camera.getPickRay(center);
        hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
      } catch {}
    }
    if (!hit) {
      try {
        hit = viewer.camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
      } catch {}
    }
    if (!hit) return null;
    const cartographic = Cesium.Cartographic.fromCartesian(hit);
    const latitude = Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = Cesium.Math.toDegrees(cartographic.longitude);
    return [latitude, longitude].every(Number.isFinite) ? { latitude, longitude, cartesian: hit } : null;
  };

  const updateView = () => {
    const cameraCartographic = viewer.camera.positionCartographic;
    const ground = pickGroundCenter();
    if (ground) lastGroundCenter = { latitude: ground.latitude, longitude: ground.longitude };
    const height = cameraCartographic?.height;
    if (Number.isFinite(height)) {
      onViewChange({ ...lastGroundCenter, height });
    }
  };

  const targetFrame = () => {
    const target = pickGroundCenter()?.cartesian
      ?? Cesium.Cartesian3.fromDegrees(lastGroundCenter.longitude, lastGroundCenter.latitude, 0);
    const transform = Cesium.Transforms.eastNorthUpToFixedFrame(target);
    const inverse = Cesium.Matrix4.inverseTransformation(transform, new Cesium.Matrix4());
    const localOffset = Cesium.Matrix4.multiplyByPoint(inverse, viewer.camera.positionWC, new Cesium.Cartesian3());
    const range = Cesium.Cartesian3.magnitude(localOffset);
    if (!Number.isFinite(range) || range < 1) return null;
    const pitch = -Math.asin(Cesium.Math.clamp(localOffset.z / range, -1, 1));
    const heading = Math.atan2(-localOffset.x, -localOffset.y);
    return { target, range, pitch, heading };
  };

  const applyFrame = (frame: any, pitch: number, heading: number, range = frame.range) => {
    viewer.camera.lookAt(frame.target, new Cesium.HeadingPitchRange(heading, pitch, range));
    const destination = Cesium.Cartesian3.clone(viewer.camera.positionWC);
    const direction = Cesium.Cartesian3.clone(viewer.camera.directionWC);
    const up = Cesium.Cartesian3.clone(viewer.camera.upWC);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.camera.setView({ destination, orientation: { direction, up } });
    viewer.scene?.requestRender?.();
  };

  let removeOrientationAnimation: (() => void) | null = null;
  const animateFrame = (
    frame: any,
    destination: { pitch: number; heading: number; range?: number },
    durationMs = 650,
  ) => {
    removeOrientationAnimation?.();
    removeOrientationAnimation = null;
    releaseContinuousRender('camera-orientation');
    holdContinuousRender('camera-orientation');
    const start = performance.now();
    const targetRange = destination.range ?? frame.range;
    const headingDelta = Cesium.Math.negativePiToPi(destination.heading - frame.heading);
    const remove = viewer.scene.preUpdate.addEventListener(() => {
      const t = Cesium.Math.clamp((performance.now() - start) / durationMs, 0, 1);
      const eased = Cesium.EasingFunction.CUBIC_IN_OUT(t);
      applyFrame(
        frame,
        Cesium.Math.lerp(frame.pitch, destination.pitch, eased),
        frame.heading + headingDelta * eased,
        Cesium.Math.lerp(frame.range, targetRange, eased),
      );
      if (t >= 1) {
        remove();
        releaseContinuousRender('camera-orientation');
        if (removeOrientationAnimation === remove) removeOrientationAnimation = null;
      }
    });
    removeOrientationAnimation = remove;
    viewer.scene?.requestRender?.();
  };

  const pickedObjectId = (picked: any) => {
    if (typeof picked?.id === 'string') return picked.id;
    if (typeof picked?.id?.id === 'string') return picked.id.id;
    if (typeof picked?.primitive?.id === 'string') return picked.primitive.id;
    if (typeof picked?.primitive?.id?.id === 'string') return picked.primitive.id.id;
    return null;
  };

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: any) => {
    const picked = viewer.scene.pick(movement.position);
    const id = pickedObjectId(picked);
    if (typeof id === 'string') {
      onEntityClick(id);
    } else {
      let scenePoint: any;
      try {
        if (viewer.scene.pickPositionSupported) {
          scenePoint = viewer.scene.pickPosition(movement.position);
        }
      } catch {
        scenePoint = undefined;
      }
      const ray = viewer.camera.getPickRay(movement.position);
      const terrainPoint = ray
        ? viewer.scene.globe.pick(ray, viewer.scene)
        : undefined;
      const earthPoint = scenePoint
        ?? terrainPoint
        ?? viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
      if (!earthPoint) {
        onEmptyClick?.(null);
        return;
      }
      const cartographic = Cesium.Cartographic.fromCartesian(earthPoint);
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
    const id = pickedObjectId(picked);
    if (typeof id === 'string') {
      onEntityHover(id, {
        x: Number(movement.endPosition?.x ?? 0),
        y: Number(movement.endPosition?.y ?? 0),
      });
    } else {
      onEntityHover(null, null);
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  viewer.camera.moveEnd.addEventListener(updateView);
  updateView();

  return {
    viewer,
    setMapStyle: (style: GroundMapStyle) => mapController.setStyle(style),
    setMapMode: async (mode: WorldMapMode) => {
      const result = await mapController.setMode(mode);
      for (const label of GEO_LABELS_DE) {
        const entity = viewer.entities.getById(`geo-label:${label.id}`);
        if (entity) entity.show = result.activeMode !== 'map';
      }
      return result;
    },
    home: () => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lastGroundCenter.longitude, lastGroundCenter.latitude, 6_500_000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 0.9,
      });
    },
    toggleTilt: () => {
      const frame = targetFrame();
      if (!frame) return;
      const tilted = frame.pitch > Cesium.Math.toRadians(-60);
      // A stronger oblique target than the old -35° makes the scene read much
      // more like GEV/Google Earth while still orbiting the visible target.
      animateFrame(frame, {
        pitch: tilted ? Cesium.Math.toRadians(-89) : Cesium.Math.toRadians(-25),
        heading: frame.heading,
      });
    },
    northUp: () => {
      const frame = targetFrame();
      if (!frame) return;
      animateFrame(frame, { pitch: frame.pitch, heading: 0 });
    },
    flyTo: (point) => {
      lastGroundCenter = { latitude: point.latitude, longitude: point.longitude };
      removeOrientationAnimation?.();
      removeOrientationAnimation = null;
      const target = Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 0);
      const range = Math.max(4_000, point.height ?? 55_000);
      // Fly around the destination target rather than placing the camera above
      // it and pitching away from it. This keeps the searched place centered.
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(target, 1),
        {
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), range),
          duration: 1.1,
        },
      );
    },
    destroy: () => {
      removeOrientationAnimation?.();
      removeOrientationAnimation = null;
      releaseContinuousRender('camera-orientation');
      viewer.camera.moveEnd.removeEventListener(updateView);
      handler.destroy();
      mapController.destroy();
      uninstallRenderGovernor(viewer);
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}
