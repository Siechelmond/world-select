import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../components/WorldSelectApp.tsx', import.meta.url), 'utf8');
const forbiddenImports = [
  '@/lib/usgs',
  '@/lib/aircraft',
  '@/lib/celestrak',
  '@/lib/traffic',
  '@/lib/cesium-viewer',
  '@/lib/layer-runtime',
];
const violations = forbiddenImports.filter((value) => shell.includes(`from "${value}"`) || shell.includes(`from '${value}'`));
if (violations.length) {
  console.error(`React/runtime boundary violation: ${violations.join(', ')}`);
  process.exit(1);
}
const runtime = readFileSync(new URL('../runtime/app/application.ts', import.meta.url), 'utf8');
if (!runtime.includes("@/runtime/layers/aircraft") || !runtime.includes("@/runtime/layers/satellites")) {
  console.error('Runtime owner does not own core moving layers');
  process.exit(1);
}
console.log('check:boundaries PASS — React shell has no direct F1 provider/motion ownership');
