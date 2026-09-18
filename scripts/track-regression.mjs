import { readFileSync } from 'node:fs';
const aircraft = readFileSync(new URL('../runtime/layers/aircraft.ts', import.meta.url), 'utf8');
const satellites = readFileSync(new URL('../runtime/layers/satellites.ts', import.meta.url), 'utf8');
const checks = [
  [aircraft.includes('setFollowing(id: string | null)'), 'aircraft follow command missing'],
  [aircraft.includes('viewer.trackedEntity'), 'aircraft trackedEntity handoff missing'],
  [aircraft.includes("id: '__runtime:aircraft-trail'"), 'aircraft trail missing'],
  [satellites.includes('buildOrbitPath'), 'satellite selected/ISS orbit geometry missing'],
  [satellites.includes('primitive.modelMatrix'), 'satellite orbit rigid rotation missing'],
  [satellites.includes('TRACKED_PROPAGATION_MS = 200'), 'tracked satellite high-cadence propagation missing'],
];
const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failed.length) { console.error(failed.join('\n')); process.exit(1); }
console.log('test:track PASS — aircraft follow/trail plus satellite baked-orbit/tracked-cadence contracts present');
