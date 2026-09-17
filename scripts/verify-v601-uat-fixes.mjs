import fs from 'node:fs';
import assert from 'node:assert/strict';

const component = fs.readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../lib/cesium-viewer.ts', import.meta.url), 'utf8');
const satellites = fs.readFileSync(new URL('../functions/api/satellites.ts', import.meta.url), 'utf8');

const checks = [
  ['Ground gets a dedicated street/city basemap', viewer.includes('World_Street_Map/MapServer') && viewer.includes('GROUND_BASEMAP_HEIGHT_M')],
  ['Earth imagery remains the high-altitude basemap', viewer.includes('World_Imagery/MapServer') && viewer.includes('earthLayer.show = !ground')],
  ['Street lookup is map-centered instead of selection-centered', component.includes('const streetPoint = viewCenter;')],
  ['Annotations can still target the selected spatial entity', component.includes('const annotationPoint = selected') && component.includes('annotationPoint.latitude')],
  ['Aircraft query coverage ellipse is not rendered as a fake aircraft cue', !component.includes('aircraft-query-coverage') && !component.includes('aircraftCoverageRef')],
  ['Aircraft cold failures retry without overlapping slow calls', component.includes('const schedule = async (initial: boolean)') && component.includes('60_000') && component.includes('window.setTimeout')],
  ['Dense catalog has multiple constellation fallbacks', ['IRIDIUM-NEXT', 'ONEWEB', 'STARLINK'].every((name) => satellites.includes(name))],
  ['Satellite API exposes partial-group diagnostics', satellites.includes('X-World-Select-Satellite-Failed-Groups') && satellites.includes('X-World-Select-Satellite-Groups')],
  ['UI identifies v6.0.1 foundation', component.includes('v6.0.1 foundation')],
];

for (const [name, ok] of checks) {
  assert.ok(ok, name);
  console.log(`PASS ${name}`);
}
console.log(`\n${checks.length}/${checks.length} v6.0.1 UAT-fix checks passed.`);
