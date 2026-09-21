import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const aircraftCore = fs.readFileSync(path.join(root, 'functions/api/aircraft-core.ts'), 'utf8');
const aircraftApi = fs.readFileSync(path.join(root, 'functions/api/aircraft.ts'), 'utf8');
const aircraftClient = fs.readFileSync(path.join(root, 'lib/aircraft.ts'), 'utf8');
const component = fs.readFileSync(path.join(root, 'components/WorldSelectApp.tsx'), 'utf8');
const streetApi = fs.readFileSync(path.join(root, 'functions/api/street.ts'), 'utf8');
const telescopeApi = fs.readFileSync(path.join(root, 'functions/api/telescope.ts'), 'utf8');
const telescopeClient = fs.readFileSync(path.join(root, 'lib/telescope.ts'), 'utf8');
const spaceExplorer = fs.readFileSync(path.join(root, 'components/SpaceExplorer.tsx'), 'utf8');
const celestialBridge = fs.readFileSync(path.join(root, 'runtime/gev/layers/celestial-bridge-renderer.ts'), 'utf8');

const checks = [
  ['adsb.lol uses documented lat/lon/dist route', aircraftCore.includes('/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}')],
  ['legacy adsb.lol /v2/point route removed', !aircraftCore.includes('/v2/point/') && !aircraftApi.includes('/v2/point/')],
  ['aircraft API has only OpenSky + adsb.lol provider contract', aircraftApi.includes('["opensky", "adsb.lol"]') && !aircraftApi.includes('airplanes.live') && !aircraftApi.includes('adsb.fi')],
  ['aircraft API can return stale/degraded cache', aircraftApi.includes('degraded: true') && aircraftApi.includes('cached: true')],
  ['client consumes aircraft feed metadata', aircraftClient.includes('AircraftFeedMeta') && component.includes('setAircraftMeta(meta)')],
  ['stale aircraft are not projected as fresh motion', component.includes('spatial.dataState !== "STALE"')],
  ['KartaView search stays within documented 500 m radius', streetApi.includes('const searchRadiusM = 500')],
  ['UI still exposes explicit Degraded state', component.includes('effectiveState === "degraded"')],
  ['keyless Telescope uses NASA Image and Video Library API', telescopeApi.includes('https://images-api.nasa.gov/search') && telescopeClient.includes('/api/telescope')],
  ['Telescope is isolated inside Space Explorer', spaceExplorer.includes('TELESCOPE') && spaceExplorer.includes('if (!telescopeOpen) return')],
  ['Earth planet bodies remain independent of orbit-line toggle', celestialBridge.includes('const visibleBodies = candidates.filter') && celestialBridge.includes('if (args.showOrbits)') && component.includes('showOrbits: planetOrbits')],
  ['Earth orbit is excluded from Earth-relative orbit projection', celestialBridge.includes('if (planet.entity.name === "Earth") continue;') && celestialBridge.includes('const vector = earthRelative(planet, earth);')],
  ['compressed planet reveal completes within bounded Earth context span', celestialBridge.includes('SOLAR_CONTEXT_REVEAL_SPAN_M = 6_500_000') && !celestialBridge.includes('normalizedDistance(distanceAu) * 24_000_000')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`\n${failed} runtime contract check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} runtime contract checks passed.`);
