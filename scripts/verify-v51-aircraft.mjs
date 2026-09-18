import fs from 'node:fs';

const api = fs.readFileSync(new URL('../functions/api/aircraft.ts', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../functions/api/aircraft-core.ts', import.meta.url), 'utf8');

const checks = [
  ['OpenSky OAuth token timeout is 12s', api.includes('OPEN_SKY_TOKEN_TIMEOUT_MS = 12_000')],
  ['OpenSky state timeout is 12s', api.includes('OPEN_SKY_STATES_TIMEOUT_MS = 12_000')],
  ['auto mode falls back to anonymous OpenSky', api.includes('return "anonymous";')],
  ['OAuth token failure can use anonymous-fallback', api.includes('"anonymous-fallback"')],
  ['provider order keeps OpenSky before adsb.lol', api.includes('["opensky", "adsb.lol"]')],
  ['status exposes OpenSky auth mode safely', api.includes('openSkyAuthMode: modeForOpenSky')],
  ['diagnostics contain provider phase', api.includes('phase: error.phase')],
  ['adsb.lol documented lat/lon/dist route retained', core.includes('/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
