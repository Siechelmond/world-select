import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const checks = [];
const check = (label, pass) => checks.push([label, Boolean(pass)]);

const aircraftApi = read('../functions/api/aircraft.ts');
const militaryApi = read('../functions/api/military.ts');
const aircraftLayer = read('../runtime/layers/aircraft.ts');
const satelliteLayer = read('../runtime/layers/satellites.ts');
const trafficLayer = read('../runtime/layers/traffic.ts');
const mapStack = read('../runtime/maps/controller.ts');
const routeApi = read('../functions/api/route.ts');
const routeService = read('../runtime/app/route-service.ts');
const app = read('../components/WorldSelectApp.tsx');

check('global aircraft uses direct OpenSky states/all', aircraftApi.includes('scope === "global"') && aircraftApi.includes('states/all'));
check('configured gateway no longer shadows direct OpenSky', aircraftApi.includes('if (modeForOpenSky !== "disabled")') && aircraftApi.indexOf('tryProvider("opensky"') < aircraftApi.indexOf('fallbackProviders'));
check('regional fallbacks run concurrently', aircraftApi.includes('Promise.all(fallbackProviders.map'));
check('military feed uses adsb.lol global military endpoint', militaryApi.includes('https://api.adsb.lol/v2/mil'));
check('military feed has last-good stale cache path', militaryApi.includes("'X-World-Select-Aircraft-Stale': '1'"));
check('aircraft has class-specific glyphs', aircraftLayer.includes('AIRCRAFT_ICONS') && aircraftLayer.includes('helicopter') && aircraftLayer.includes('fastjet'));
check('aircraft supports ALL/CIV/MIL filtering', aircraftLayer.includes("'all' | 'civilian' | 'military'") && app.includes('aria-label="Aircraft filter"'));
check('satellites have glyph LOD', satelliteLayer.includes('SATELLITE_ICON') && satelliteLayer.includes('BillboardCollection'));
check('satellite orbit geometry is built synchronously once', satelliteLayer.includes('asynchronous: false') && satelliteLayer.includes('modelMatrix'));
check('selected satellite has faster propagation cadence', satelliteLayer.includes('TRACKED_PROPAGATION_MS = 200'));
check('traffic configured-but-probe-failed still attaches viewport tiles', trafficLayer.includes('if (!status.configured)') && trafficLayer.includes('this.attachLayers()'));
check('default map stack is keyless and Google is not loaded at boot', mapStack.includes('Esri World Imagery') && !mapStack.includes('Google2DImageryProvider'));
check('keyless OSRM route proxy exists', routeApi.includes('routing.openstreetmap.de') && routeApi.includes("'foot' | 'car' | 'bike'"));
check('route flythrough is a runtime camera operation', routeService.includes('requestAnimationFrame') && routeService.includes('camera.setView'));
check('directions UI exposes WALK/DRIVE/BIKE + FLY', app.includes('>WALK<') && app.includes('>DRIVE<') && app.includes('>BIKE<') && app.includes('>FLY<'));

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failed += 1;
}
if (failed) process.exit(1);
console.log(`qa:gev-core PASS — ${checks.length} architecture/capability invariants`);
