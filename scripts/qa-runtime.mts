import { readFileSync } from 'node:fs';
import { selectNearestCohort } from '../runtime/core/cohort.ts';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const fixture = Array.from({ length: 5000 }, (_, index) => ({
  id: `fixture-${index}`,
  position: {
    latitude: 48.2082 + ((index % 100) - 50) * 0.01,
    longitude: 16.3738 + (Math.floor(index / 100) - 25) * 0.01,
  },
}));
const cohort = selectNearestCohort(fixture, { latitude: 48.2082, longitude: 16.3738 }, 1800, 'fixture-4999');
invariant(cohort.length === 1800, `expected bounded cohort of 1800, got ${cohort.length}`);
invariant(cohort.some((item) => item.id === 'fixture-4999'), 'selected/pinned aircraft must remain in visible cohort');
invariant(new Set(cohort.map((item) => item.id)).size === cohort.length, 'cohort must not contain duplicates');

const appSource = readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');
for (const forbidden of ['fetchEarthquakes', 'fetchAircraftSnapshot', 'fetchStationTles', 'fetchTrafficStatus', 'projectAircraftPosition', 'createWorldViewer']) {
  invariant(!appSource.includes(forbidden), `React shell still owns runtime concern: ${forbidden}`);
}
invariant(appSource.includes('new WorldSelectRuntime'), 'React shell must create the runtime owner exactly once');
invariant(appSource.includes('runtimeRef.current?.setSceneActive(false)'), 'Space/Street must suspend scene work without destroying viewer');

const runtimeSource = readFileSync(new URL('../runtime/app/application.ts', import.meta.url), 'utf8');
invariant((runtimeSource.match(/new this\.Cesium\.Viewer/g) ?? []).length === 1, 'runtime must contain exactly one Viewer constructor');
invariant(runtimeSource.includes('new EarthquakeLayer()') && runtimeSource.includes('new SatelliteLayer()') && runtimeSource.includes('new AircraftLayer()') && runtimeSource.includes('new TrafficLayer()'), 'all four F1 workload classes must be registered');

const aircraftSource = readFileSync(new URL('../runtime/layers/aircraft.ts', import.meta.url), 'utf8');
invariant(aircraftSource.includes("this.stats.state = this.records.size ? 'degraded' : 'unavailable'"), 'aircraft must distinguish last-good degraded from cold unavailable');
invariant(aircraftSource.includes('coverage: snapshot.meta.coverage'), 'aircraft coverage provenance must remain explicit');

console.log('qa:runtime PASS — 5000-aircraft deterministic fixture, bounded cohort, runtime ownership, lifecycle/status invariants');
