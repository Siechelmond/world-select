import fs from 'node:fs';
import assert from 'node:assert/strict';

const component = fs.readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../lib/cesium-viewer.ts', import.meta.url), 'utf8');
const labels = fs.readFileSync(new URL('../lib/geo-labels.ts', import.meta.url), 'utf8');
const satellites = fs.readFileSync(new URL('../functions/api/satellites.ts', import.meta.url), 'utf8');
const street = fs.readFileSync(new URL('../lib/google-street.ts', import.meta.url), 'utf8');

const checks = [
  ['viewer lifecycle extracted from component', component.includes('createWorldViewer') && !component.includes('new Cesium.Viewer(')],
  ['Esri imagery is primary with OSM fallback', viewer.includes('World_Imagery/MapServer') && viewer.includes('OpenStreetMapImageryProvider')],
  ['labels are English-first', labels.includes('GEO_LABELS_EN') && labels.includes('Austria') && labels.includes('Atlantic Ocean') && !labels.includes('GEO_LABELS_DE')],
  ['Street coverage is checked before opening', component.indexOf('findGoogleStreetCoverage') < component.indexOf('setStreetOpen(true)')],
  ['Street no-coverage remains on globe', component.includes('No street imagery nearby — staying on Globe')],
  ['Street always exposes Back to Globe', component.includes('← Back to Globe')],
  ['camera pose is captured/restored around Street', component.includes('captureCameraPose') && component.includes('restoreCameraPose')],
  ['satellite core includes outer GNSS/GEO regimes', ['GPS-OPS', 'GLO-OPS', 'GALILEO', 'GEO'].every((name) => satellites.includes(name))],
  ['Starlink is dense opt-in', satellites.includes("catalog === 'dense'") && satellites.includes("{ name: 'STARLINK'")],
  ['Satellite CORE/DENSE control is visible', component.includes('satelliteCatalogSwitch') && component.includes('DENSE')],
  ['Google Street lookup is separated from the renderer', street.includes('findGoogleStreetCoverage') && street.includes('StreetViewService')],
];

for (const [name, ok] of checks) { assert.ok(ok, name); console.log(`PASS ${name}`); }
console.log(`\n${checks.length}/${checks.length} v6 foundation checks passed.`);
