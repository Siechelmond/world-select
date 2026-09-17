# WORLD_SELECT_F1_RUNTIME_TRANSPLANT — MANIFEST

Baseline branch: `world-select-v6-foundation`  
Baseline SHA: `244447a54396463a983cb243384ad8a4728882da`  
Main SHA observed read-only: `20a4ad6ef1390c960ffadb4ab752bc1ab42589d0`

## Changed from baseline

- `components/WorldSelectApp.tsx`
- `package.json`
- new `runtime/` foundation
- new F1 QA scripts
- `docs/UAT_F1_RUNTIME_TRANSPLANT.md`

## Not changed

All existing `functions/api/*` provider implementations remain byte-for-byte from the supplied v6.0.2 baseline.

## Local QA result

`npm run qa:f1` -> PASS  
TypeScript syntax/transpile -> PASS  
Strict project type-check with temporary dependency declarations -> PASS  
Secret scan -> no committed credential values found

`npm run build` / browser QA -> not executed because package-registry access is unavailable in this execution environment (`EAI_AGAIN`).
