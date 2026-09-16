import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const aircraftCore = fs.readFileSync(path.join(root, 'functions/api/aircraft-core.ts'), 'utf8');
const aircraftApi = fs.readFileSync(path.join(root, 'functions/api/aircraft.ts'), 'utf8');
const aircraftClient = fs.readFileSync(path.join(root, 'lib/aircraft.ts'), 'utf8');
const component = fs.readFileSync(path.join(root, 'components/WorldSelectApp.tsx'), 'utf8');
const streetApi = fs.readFileSync(path.join(root, 'functions/api/street.ts'), 'utf8');

const checks = [
  ['adsb.lol uses documented lat/lon/dist route', aircraftCore.includes('/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}')],
  ['legacy adsb.lol /v2/point route removed', !aircraftCore.includes('/v2/point/') && !aircraftApi.includes('/v2/point/')],
  ['aircraft API has only OpenSky + adsb.lol provider contract', aircraftApi.includes('["opensky", "adsb.lol"]') && aircraftApi.includes('["adsb.lol", "opensky"]')],
  ['aircraft API can return stale/degraded cache', aircraftApi.includes('degraded: true') && aircraftApi.includes('cached: true')],
  ['client consumes aircraft feed metadata', aircraftClient.includes('AircraftFeedMeta') && component.includes('setAircraftMeta(meta)')],
  ['stale aircraft are not projected as fresh motion', component.includes('spatial.dataState !== "STALE"')],
  ['KartaView search stays within documented 500 m radius', streetApi.includes('const searchRadiusM = 500')],
  ['UI still exposes explicit Degraded state', component.includes('effectiveState === "degraded"')],
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
