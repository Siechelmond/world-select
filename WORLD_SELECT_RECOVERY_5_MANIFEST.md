# WORLD SELECT — RECOVERY 5 MANIFEST

Date: 2026-09-17
Scope: `Siechelmond/world-select` only, target branch `world-select-v6-foundation`.
Base: Recovery 4 UAT/deployed bundle.

## Purpose

Continue the end-state build while closing UAT regressions without replacing working Earth/Satellite/ISS/Space foundations.

## UAT regressions fixed

1. **Cesium aircraft follow/trail render crash**
   - Replaces invalid `ConstantProperty(Color)` material assignment with `ColorMaterialProperty`.
   - Targets the observed `TypeError: t.getType is not a function` rendering stop.

2. **Aircraft globe-density / white-aircraft carpet**
   - Far-globe LOD now reduces, rather than increases, visible aircraft.
   - Far-distance glyphs are smaller while selected aircraft remain retained by cohort logic.
   - Regional civilian coverage is drawn as a very subtle cyan coverage circle so a regional cohort is not mistaken for worldwide completeness.

3. **Fresh aircraft mislabeled STALE**
   - Provider degradation no longer automatically marks every current aircraft observation stale.
   - `STALE` is now reserved for explicitly stale snapshots; fresh regional fallback observations remain `OBSERVED` while the layer can still be `DEGRADED`.

4. **Space TIME controls overlap**
   - SPACE timebar gets a dedicated responsive layout.
   - Playback controls wrap to a second row on constrained desktop widths and reflow on mobile.

5. **Opaque provider failures**
   - Failed layers now expose the actual provider/runtime diagnostic in the layer card instead of only `Live source unavailable`.
   - Street failure toast now includes Google/KartaView diagnostic context while preserving the non-freezing Globe fallback.

## End-goal continuation

### Milky Way realism pass
- Adds diffuse stellar-cloud structure along spiral arms.
- Adds a broader central bulge halo.
- Softens schematic arm strokes and deepens dust lanes.
- Keeps `YOU ARE HERE`, Orion Spur and the explicit scientific-context disclaimer.

### Preserved working behavior
- Earthquakes atomic/last-good runtime.
- Satellite SGP4 propagation, CORE/DENSE, ISS orbit and hover live stream.
- Planet systems and moon time animation.
- Solar System / Kuiper Belt / Milky Way hierarchy.
- Aircraft source separation ALL/CIV/MIL and retained source stores.
- Directions implementation.
- Persistent Cesium Earth viewer and keyless Esri/OSM boot path.
- Street exception handling that never freezes the Globe.

## QA

`npm run qa:f1` PASS.

Includes:
- 5,000-aircraft deterministic runtime fixture.
- track/follow regression contract.
- package boundary check.
- keyless map-stack check.
- Street timeout/fallback suite.
- 45 GEV/Space architecture and capability invariants.

A full `next build` is not claimed in this container because project dependencies are not installed locally.

## Full-upload packaging correction

- Removed the accidental nested `ws-recovery4/` duplicate from the upload bundle.
- Restored the repository `.github/` container for GitHub Desktop; the historical Pages workflow is retained with a `.disabled` suffix so it cannot execute.
- The archived GitHub Pages workflow is intentionally inactive; World Select continues to deploy via Cloudflare Pages.
- No application/runtime import depends on `.github/`.
