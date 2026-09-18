# World Select ws-pv — GEV Runtime Transplant F1

Donor baseline: `bilawalsidhu/gods-eye-view@0d41b6be5490db1f10a171f238be75db4d4ec3b4`.

This branch deliberately starts from World Select `main` and moves Earth runtime ownership toward the proven GEV pattern instead of extending the old recovery branch.

## F1 ownership changes

- React no longer owns the network cadence for Earthquakes, Satellites, Civil Aircraft and Military Aircraft.
- `runtime/gev/core-live-world.ts` owns independent refresh loops, aborts, last-good retention and layer enable/disable state.
- Civil Aircraft and Military are independent sources. A failure in one cannot clear the other.
- Core live layers are enabled on a fresh private-view session.
- Military uses a dedicated adsb.lol global snapshot route with cache, stale-on-failure and bounded cooldown.
- Existing World Select Cesium rendering remains temporarily in place for F1 so the source/lifecycle transplant can be verified before renderer ownership moves.
- World Select Space remains untouched.

## Next transplant seams

1. Move Cesium resource ownership from React into per-layer renderers.
2. Adopt the GEV scene/viewer + keyless/photoreal map-stack path.
3. Replace raster Traffic with the GEV OSM-road + optional TomTom-vector-flow + PointPrimitive renderer.
4. Add CCTV, vessels, fires, submarine cables, infrastructure, radio and launches after the four F1 layers are stable together.

See `THIRD_PARTY_NOTICES.md` for the donor MIT notice.
