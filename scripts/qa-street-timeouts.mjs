import fs from 'node:fs';

const google = fs.readFileSync(new URL('../lib/google-street.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../lib/street.ts', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../functions/api/street.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');

const checks = [
  ['Google Maps load has hard timeout', google.includes('GOOGLE_MAPS_LOAD_TIMEOUT_MS') && google.includes('withTimeout(loadPromise')],
  ['Google coverage has hard timeout', google.includes('STREET_COVERAGE_TIMEOUT_MS') && google.includes("'Google Street View coverage check'")],
  ['KartaView browser proxy has hard timeout', client.includes('STREET_PROXY_TIMEOUT_MS') && client.includes('AbortController')],
  ['KartaView worker upstream has hard timeout', worker.includes('KartaView upstream timeout') && worker.includes('AbortController')],
  ['Street failure stays on Globe', app.includes('Street imagery unavailable — staying on Globe') && app.includes('setStreetOpen(false)')],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failed++;
}
if (failed) process.exit(1);
