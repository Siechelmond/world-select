import { readFileSync } from 'node:fs';
const aircraft = readFileSync(new URL('../runtime/layers/aircraft.ts', import.meta.url), 'utf8');
const satellites = readFileSync(new URL('../runtime/layers/satellites.ts', import.meta.url), 'utf8');
const checks = [
  [aircraft.includes('setFollowing(id: string | null)'), 'aircraft follow command missing'],
  [aircraft.includes('viewer.trackedEntity'), 'aircraft trackedEntity handoff missing'],
  [aircraft.includes("id: '__runtime:aircraft-trail'"), 'aircraft trail missing'],
  [satellites.includes("id: '__runtime:satellite-trail'"), 'satellite selected trail missing'],
  [satellites.includes('this.selectedTrail'), 'satellite shared propagation trail cache missing'],
];
const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failed.length) { console.error(failed.join('\n')); process.exit(1); }
console.log('test:track PASS — aircraft follow/trail and satellite selected-trail contracts present');
