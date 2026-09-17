# WORLD SELECT — F1 RUNTIME TRANSPLANT

**Date:** 2026-09-17  
**Artifact:** `WORLD_SELECT_F1_RUNTIME_TRANSPLANT`  
**Source baseline:** `world-select-v6-foundation` @ `244447a54396463a983cb243384ad8a4728882da`  
**Production/main observed:** `20a4ad6ef1390c960ffadb4ab752bc1ab42589d0`  
**Repository mutation:** none

## What changed

F1 replaces `components/WorldSelectApp.tsx` as the live spatial runtime owner with a dedicated runtime layer:

- `runtime/app/application.ts` — persistent Cesium application/viewer owner
- `runtime/app/camera-service.ts` — throttled camera service
- `runtime/app/layer-manager.ts` — explicit lifecycle/registry owner
- `runtime/app/render-governor.ts` — request-on-change render control + hidden-tab awareness
- `runtime/maps/controller.ts` — coherent Google -> Esri -> OSM imagery/reference fallback
- `runtime/layers/earthquakes.ts` — atomic snapshot + last-good
- `runtime/layers/satellites.ts` — shared SGP4 propagation clock, CORE/DENSE, bounded visible cohort
- `runtime/layers/aircraft.ts` — snapshot/last-good/interpolation/follow under a hard render budget
- `runtime/layers/traffic.ts` — independent viewport-driven traffic imagery lifecycle
- `runtime/core/cohort.ts` — deterministic bounded nearest-cohort selection

The React shell now owns product UI only: layer commands, coarse status snapshots, Inspector, Time, Space, Street pre-flight and annotations. It does not fetch or animate the four F1 live layers.

## Preserved product behavior

- World Select branding and existing UI structure
- Earth / Ground / Space navigation
- Ground remains the same Cesium scene; no height-triggered basemap replacement
- Solar-system view remains detached from Cesium live-layer ownership
- Street View / KartaView remains optional and uses pre-flight coverage checks
- `Back to Globe` restores the captured Cesium camera pose
- Annotations remain local-session UI state but render through the runtime
- Existing Cloudflare provider functions are unchanged

## F1 runtime status semantics

Each F1 layer implements `init / enable / disable / retry / setSceneActive / onCameraChanged / getStats / destroy`.

Aircraft specifically preserves the required semantics:

- fresh provider snapshot -> `live`
- refresh failure after useful snapshot -> `degraded` and last-good stays visible
- cold failure -> `unavailable`
- `coverage` provenance remains explicit (`regional` vs `worldwide`)

## Performance controls

- one Cesium Viewer constructor in the runtime
- React receives no fleet-wide interpolation ticks
- request-render mode enabled
- moving camera emissions are throttled
- aircraft materialization budget: 20,000 records
- aircraft visible-glyph budget: max 1,800; interpolation at 250 ms only when useful
- selected aircraft remains pinned in the visible cohort
- satellite materialization budget: 6,000; visible propagation budget max 2,200
- labels, trails and expensive geometry have independent hard caps
- Space/Street suspend active scene work without destroying the Viewer
- hidden tab suppresses moving-layer render work through the render governor

## Automated F1 QA executed locally

`npm run qa:f1` passes:

- deterministic 5,000-aircraft fixture -> bounded 1,800 visible cohort
- pinned selected aircraft survives cohort clipping
- React/runtime boundary check
- exactly one Viewer constructor in runtime source
- all four F1 workload classes registered
- aircraft degraded/unavailable + coverage provenance contract
- aircraft follow/trail regression contract
- satellite selected-trail contract
- no height-driven basemap switching
- Ground is a same-scene camera operation

A TypeScript syntax/transpile pass was also run across app/components/lib/runtime/functions. A strict project type-check with temporary dependency declarations passed.

## Environment limitation in this execution environment

`npm install` could not reach `registry.npmjs.org` (`EAI_AGAIN`), so a real `next build` and local browser run could not be executed here. This is an execution-environment network limitation, not a green build claim.

Therefore F1 is **source/contract QA green, browser/build QA pending**. Do not merge to `main` or call Production ready until a dependency-enabled build and browser preview pass.

## Intentionally unchanged

- `functions/api/aircraft.ts` provider/gateway behavior
- `functions/api/traffic.ts`
- `functions/api/satellites.ts`
- `functions/api/street.ts`
- OpenSky/Render gateway topology
- Cloudflare environment variables/secrets
- Production deployment
- `main`
- `world-select-v6-foundation`
- any other SELECT project

## Next acceptance step

On an isolated F1 branch/preview only:

1. `npm install`
2. `npm run build`
3. `npm run qa:f1`
4. start preview
5. verify one Viewer across layer toggles / Ground / Inspector / Street return
6. verify all four F1 layers simultaneously
7. record moving/parked FPS, viewport, DPR, object counts, activation times and memory where available
8. mobile viewport smoke test
9. only then consider PR/release
