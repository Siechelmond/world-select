import fs from 'node:fs';
const app = fs.readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../lib/cesium-viewer.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const checks = [
  ['no height-driven basemap threshold', !viewer.includes('GROUND_BASEMAP_HEIGHT_M') && !viewer.includes('applyBasemapMode')],
  ['explicit map style contract', viewer.includes("setMapStyle: (style: GroundMapStyle)")],
  ['ground is explicit state', app.includes('const [groundMode, setGroundMode]')],
  ['earth style explicit', app.includes('setMapStyleRef.current?.("earth")')],
  ['ground style explicit', app.includes('setMapStyleRef.current?.("ground")')],
  ['street restore deferred', app.includes('window.requestAnimationFrame(() =>')],
  ['street escape return', app.includes('event.key === "Escape"')],
  ['prominent street back button', css.includes('.streetHead .backToGlobe') && css.includes('min-width: 150px')],
  ['imagery reference overlay', viewer.includes('World_Boundaries_and_Places')],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log(`${checks.length}/${checks.length} v6.0.2 checks passed`);
