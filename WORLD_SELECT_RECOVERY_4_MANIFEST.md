# WORLD SELECT — RECOVERY 4 MANIFEST

Date: 2026-09-17
Target: `Siechelmond/world-select`
Target branch: `world-select-v6-foundation`
Base: deployed `WORLD_SELECT_SPACE_RECOVERY_3_2026-09-17.zip`

## Goal

Continue World Select without replacing working Earth/Orbit/Space foundations. Recovery 4 is a bounded regression + capability bundle focused on the failures visible in UAT and the requested Space improvements.

## P0 regression fixes

### Aircraft filter truth

- `ALL`, `CIV`, and `MIL` now have source-aware count/state presentation.
- Runtime publishes separate civilian and military health summaries.
- CIV can show `Unavailable` while MIL remains `Live/Degraded`; the whole layer no longer misleadingly borrows Military status for the CIV view.
- Filter buttons show their own counts.
- Existing separate civilian/military last-good stores and deduped ALL merge remain unchanged.
- Existing class glyphs, bounded interpolation, selection, follow and session trail are retained.

### Traffic recovery

- TomTom Orbis Traffic v2 remains primary.
- Added documented TomTom Traffic Raster v4 fallback for both flow and incident tiles.
- A key/project provisioned for the legacy traffic family can therefore still render rather than failing solely because Orbis is rejected.
- Viewport tiles remain attach-first/fail-soft; a probe does not gate rendering.
- If `TOMTOM_API_KEY` is absent in the Cloudflare preview environment, the UI receives an explicit environment/configuration reason instead of an ambiguous generic failure.

### Street recovery

- Google Street View coverage lookup now expands progressively: 120 m -> 250 m -> 500 m.
- Coverage lookup uses the callback contract with explicit `OK` / `ZERO_RESULTS` handling and a hard timeout.
- Google authentication/referrer failure is surfaced explicitly instead of looking like no street imagery.
- KartaView remains keyless fallback and now uses a wider 1000 m public nearby-photo search plus a more tolerant response parser.
- Existing non-freezing failure path is retained: no dead scene, no blocked Globe, clear fallback notice.

## Safe feature development

### Space TIME playback

- In SPACE only, TIME gets PLAY / PAUSE plus `1D/S`, `7D/S`, `30D/S` speeds.
- Playback advances the existing calculated planet clock and the existing simulated moon display orbits.
- Earth runtime / live Aircraft / Traffic provider ownership is not updated every playback tick.
- NOW resets playback.

### Milky Way visual upgrade

- Replaced the radial/schematic spoke look with an SVG context model containing:
  - four curved spiral arms,
  - dust lanes,
  - deterministic stellar density,
  - Galactic Center glow,
  - Orion Spur,
  - `YOU ARE HERE` Solar System marker.
- It remains explicitly a spatial context model, not a literal photograph or star-by-star reconstruction.

## Explicitly not changed

- Earthquake provider/runtime.
- Satellite SGP4 propagation.
- Satellite CORE/DENSE behavior.
- ISS orbit handling.
- ISS live-hover embed behavior.
- Existing planet/moon orbital-motion formulas.
- Directions route/flythrough implementation.
- Persistent single Cesium viewer ownership.
- Map-stack boot behavior / Google no-boot-load rule.

## Files changed vs Recovery 3

- `app/globals.css`
- `components/SpaceExplorer.tsx`
- `components/WorldSelectApp.tsx`
- `functions/api/street.ts`
- `functions/api/traffic.ts`
- `lib/google-street.ts`
- `runtime/app/application.ts`
- `runtime/layers/aircraft.ts`
- `runtime/types.ts`
- `scripts/qa-gev-core.mjs`
- `scripts/qa-street-timeouts.mjs`

## QA

- `npm run qa:f1` PASS.
- 5,000-aircraft bounded-cohort runtime QA PASS.
- Aircraft follow/trail regression PASS.
- Package-boundary QA PASS.
- Keyless map-stack QA PASS.
- Street timeout/fallback QA PASS (7 checks).
- GEV/Space architecture QA PASS (38 invariants).
- TypeScript syntax/transpile parse: no parse-class errors in changed TS/TSX files; unresolved module/type errors are expected in this container because project `node_modules` are not installed.
- Full `next build` was not run locally for the same dependency reason; Cloudflare preview build/UAT remains the deployment proof.

## Runtime dependencies that code alone cannot manufacture

- Traffic still requires `TOMTOM_API_KEY` in the active Cloudflare preview environment.
- Google Street View still requires a valid `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` whose browser referrer restrictions permit the branch-preview hostname. The code now exposes this failure distinctly and retains KartaView fallback.
