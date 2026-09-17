# WORLD SELECT — SPACE RECOVERY 3 MANIFEST

Date: 2026-09-17
Target branch: `world-select-v6-foundation`
Base commit inspected: `a274fb1381b725cc1fc2390a621fe166fa62be9e`

## Purpose

Extend the working GEV recovery without changing the persistent Earth/Cesium runtime ownership.

## Included

- Recovery 2A aircraft NOW-only dead-state correction.
- Existing separate civilian/military last-good stores retained.
- Existing traffic attach-first / advisory-probe fail-soft behavior retained.
- ISS hover card keeps the live Sen/YouTube preview and now explains legitimate dark-frame states.
- New isolated `SpaceExplorer` component with hierarchical spatial frames:
  - Planet System
  - Solar System
  - Kuiper Belt / outer system
  - Milky Way context
- Planet click enters a dedicated system view.
- Featured moons are shown for Earth, Mars, Jupiter, Saturn, Uranus and Neptune.
- Moon display positions are explicitly `SIMULATED` circular visualization orbits; no precision-ephemeris claim.
- Moon sizes/distances are explicitly expanded for visibility.
- Pluto, Haumea, Makemake and Eris are available in the outer-system view with representative orbit scales.
- Kuiper Belt point density is explicitly illustrative.
- Galaxy view is explicitly schematic, with a Solar System / Orion Spur context marker.
- Mouse wheel and +/- controls move between spatial frames without touching Earth layer state.
- Celestial-body Inspector now shows parent, category, radius, orbit radius/period, model and display-scale disclosures when present.

## Non-regression boundary

`components/SpaceExplorer.tsx` does not import or own `WorldSelectRuntime`, provider code, Earth layers, or Cesium layer lifecycle. Entering/leaving SPACE continues to use the existing single viewer scene-active handoff only.

## QA

- `npm run qa:f1` PASS.
- `qa:gev-core` PASS with 33 invariants.
- TypeScript transpile/syntax PASS for SpaceExplorer, WorldSelectApp, space model, aircraft and traffic runtime files.
- Full `next build` was not run in this environment because registry install timed out; Cloudflare preview remains the required browser/build UAT.
