export type CesiumCameraPose = {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
};

export function captureCameraPose(viewer: any): CesiumCameraPose | null {
  const camera = viewer?.camera;
  const position = camera?.positionWC;
  if (!camera || !position) return null;
  const values = [position.x, position.y, position.z, camera.heading, camera.pitch, camera.roll];
  if (!values.every(Number.isFinite)) return null;
  return {
    x: position.x,
    y: position.y,
    z: position.z,
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  };
}

export function restoreCameraPose(viewer: any, Cesium: any, pose: CesiumCameraPose | null): void {
  if (!viewer || !Cesium || !pose) return;
  viewer.camera.setView({
    destination: new Cesium.Cartesian3(pose.x, pose.y, pose.z),
    orientation: { heading: pose.heading, pitch: pose.pitch, roll: pose.roll },
  });
}
