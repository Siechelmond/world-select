# WORLD SELECT — GEV RECOVERY 2 MANIFEST

Base branch: `world-select-v6-foundation`
Base commit: `3b61dfcc0d9ef6346e2d66fbce583e7f8f683166`
Target: same branch only; `main` intentionally unchanged.

Changed behavior: independent aircraft source retention/merge, connecting grace, traffic fail-soft tile-first startup, selected-entity Street action, richer aircraft inspector, staged layer boot, ISS Sen live hover preview.

Primary changed files:
- `runtime/layers/aircraft.ts`
- `runtime/layers/traffic.ts`
- `runtime/app/application.ts`
- `runtime/types.ts`
- `components/WorldSelectApp.tsx`
- `app/globals.css`
- `scripts/qa-gev-core.mjs`
- `scripts/qa-runtime.mts`
- `package.json`
- `docs/UAT_GEV_RECOVERY_2_2026-09-17.md`

QA evidence before packaging:
- `npm run qa:f1` — PASS
- changed TS/TSX syntax transpile — PASS
- Cloudflare provider behavior still requires preview UAT after upload.
