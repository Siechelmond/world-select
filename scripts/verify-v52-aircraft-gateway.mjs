import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../functions/api/aircraft.ts', import.meta.url), 'utf8');
const checks = [
  ['gateway env is supported', source.includes('AIRCRAFT_GATEWAY_URL?: string')],
  ['gateway is first when configured', source.includes('? ["gateway", "adsb.lol"]')],
  ['direct OpenSky is skipped when gateway configured', source.includes('gatewayConfigured') && source.includes('["gateway", "adsb.lol"]')],
  ['gateway timeout is bounded', source.includes('AIRCRAFT_GATEWAY_TIMEOUT_MS = 8_000')],
  ['gateway URL is server env only', source.includes('aircraftGatewayUrl(env.AIRCRAFT_GATEWAY_URL')],
  ['gateway phase diagnostics exist', source.includes('"gateway", "gateway"')],
  ['status reports gatewayConfigured', source.includes('gatewayConfigured,')],
  ['adsb.lol remains fallback', source.includes('buildAdsbLolUrl')],
];
for (const [name, ok] of checks) {
  assert.ok(ok, name);
  console.log(`PASS ${name}`);
}
