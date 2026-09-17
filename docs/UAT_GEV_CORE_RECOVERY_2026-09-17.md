# World Select — GEV Core Recovery UAT

Date: 2026-09-17
Target branch: `world-select-v6-foundation`
Production branch: `main` — intentionally unchanged

## Purpose

This bundle turns the F1 spatial runtime into a visibly useful core: global/regional aircraft acquisition, military aircraft, stronger satellite rendering/tracking, fail-soft traffic, bounded Street View fallback, and keyless Directions with route flythrough. It also removes automatic Google map-tile loading at boot so metered Google usage is explicit/on-demand.

## Preconditions

- No secret is required for the keyless Esri/OSM map baseline, earthquakes, CelesTrak satellites, anonymous OpenSky aircraft, adsb.lol military feed, or OSM/FOSSGIS directions.
- `TOMTOM_API_KEY` is required for TomTom traffic.
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is optional and used only for explicit Street View requests. Its HTTP-referrer restrictions must include the preview hostname if Google Street View is to work there.
- Optional OpenSky OAuth credentials may raise available polling quota.

## Acceptance pass

1. **Boot / cost guard**
   - Open the branch preview with DevTools Network visible.
   - Globe starts with Esri/OSM without an automatic Google map-tile request.
   - Earthquakes and Satellites still load.

2. **Satellites**
   - Satellite fleet moves without viewer recreation.
   - Recognizable satellite glyphs appear for a bounded subset; ISS is retained as a hero object.
   - Select a satellite: label remains coherent and a true orbit ring appears.
   - Track/select remains smooth while the rest of the fleet keeps the cheaper cadence.

3. **Aircraft — global and regional**
   - From globe/continental altitude, Aircraft requests the global OpenSky path first.
   - If global OpenSky is fresh, provenance says worldwide/global rather than pretending a 250 nm fallback is worldwide.
   - If global OpenSky fails, the layer may remain useful through bounded regional/last-good data but must show DEGRADED honestly.
   - Zoom closer: regional acquisition follows the current viewport.
   - Aircraft continue moving between network snapshots.

4. **Aircraft classes / military**
   - ALL / CIV / MIL filters work without refetching the whole viewer.
   - Military contacts are amber/yellow and come from the dedicated adsb.lol military feed.
   - Helicopter/airliner/widebody/turboprop/fast-jet/light classes use differentiated glyphs when classification data supports it.
   - Select an aircraft and enable follow: camera tracks it; observed trail remains visible and bounded.

5. **Traffic**
   - With a valid `TOMTOM_API_KEY`, enabling Traffic attaches viewport-driven TomTom tiles.
   - If the low-cost status probe fails but the key is configured, the layer is DEGRADED and still attempts visible tiles instead of failing closed.
   - Traffic failure never replaces or destroys the basemap.

6. **Street**
   - Trigger Street explicitly.
   - Google coverage lookup has a hard bound; KartaView lookup is started in parallel as fallback.
   - A provider failure never leaves `Checking street imagery coverage…` indefinitely.
   - If neither source has imagery, World Select stays on the globe and reports unavailable/no coverage.
   - Close/Escape returns to the captured globe camera pose.

7. **Directions / route flythrough**
   - In Directions choose WALK, DRIVE or BIKE.
   - SET A, click the globe; SET B, click the globe.
   - A street-following route appears with distance/duration. No straight line may be presented as a real route.
   - Press FLY: camera animates along the route.
   - CLEAR removes route and markers; rerouting must not leak old markers.

8. **Regression**
   - Earthquakes still load and remain independent of the other layers.
   - Switching Ground/Earth does not recreate the Cesium viewer or swap the basemap based on camera height.
   - Space/Street pause/resume returns to the same spatial runtime.
   - No uncaught console error during the sequence above.

## Static/local QA executed before packaging

`npm run qa:f1`

Expected/verified gates:
- runtime deterministic 5,000-aircraft fixture and lifecycle invariants
- aircraft follow/trail and satellite baked-orbit/tracked-cadence contracts
- React/runtime ownership boundaries
- keyless Esri/OSM boot and no automatic Google map load
- bounded Street provider timeouts
- 15 GEV core architecture/capability invariants

A real Cloudflare/browser UAT is still required after deployment because provider reachability, deployed secrets/referrer restrictions, and external service behavior cannot be proven by local static QA.
