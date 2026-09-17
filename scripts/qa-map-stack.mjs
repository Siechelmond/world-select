import { readFileSync } from 'node:fs';
const map = readFileSync(new URL('../runtime/maps/controller.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../runtime/app/application.ts', import.meta.url), 'utf8');
if (/cameraHeight|camera\.positionCartographic|height\s*[<>]=?/.test(map)) {
  console.error('qa:map-stack FAIL — map stack contains camera-height-driven basemap switching');
  process.exit(1);
}
if (!map.includes('Google2DImageryProvider') || !map.includes('ArcGisMapServerImageryProvider') || !map.includes('OpenStreetMapImageryProvider')) {
  console.error('qa:map-stack FAIL — expected coherent Google/Esri/OSM source chain missing');
  process.exit(1);
}
if (!app.includes('flyGround()') || !app.includes('this.cameraService.flyTo')) {
  console.error('qa:map-stack FAIL — Ground must be a camera operation in the same scene');
  process.exit(1);
}
console.log('qa:map-stack PASS — no camera-height basemap swap; Ground remains one persistent Cesium scene');
