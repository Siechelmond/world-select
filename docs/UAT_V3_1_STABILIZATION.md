# World Select v3.1 — Stabilization & UAT

## Scope

v3.1 is a stabilization release. It does not add a new product vertical.

### Fixed / hardened

1. **Earthquakes**
   - anchored to the ellipsoid/ground at the USGS event latitude/longitude
   - depth testing is enabled; markers on the far side of Earth are no longer forced through the globe
   - earthquake entities are not rebuilt every second when satellites move

2. **Satellites**
   - CelesTrak is accessed via `/api/satellites` Cloudflare Pages Function
   - TLE/GP data is cached server-side; browser CORS is removed from the critical path
   - current TLE records are propagated with SGP4 every second while TIME = NOW
   - satellite entities are position-updated instead of rebuilding all Earth layers

3. **Aircraft**
   - ADSB.lol is accessed via `/api/aircraft` Cloudflare Pages Function
   - 250 NM around the current view center
   - refresh every 15 seconds
   - explicit empty/error state per layer

4. **Street level**
   - no Google Maps outbound link
   - KartaView public street-level imagery is queried via `/api/street`
   - imagery is rendered inside World Select
   - explicit NO COVERAGE state when there is no public imagery

5. **Diagnostics**
   - per-layer status/error text rather than one undifferentiated global error

## Cloudflare requirement

The `functions/api/` directory is now part of the deployment. The project must remain a Cloudflare **Pages** project connected to the repository. No database or API secret is required for v3.1.

## UAT checklist

- Rotate Earth: earthquake points on the far side are occluded by the globe.
- Observe one satellite for 10–30 seconds at NOW: its position changes continuously.
- Satellite layer reports a non-zero count or an explicit source error.
- Aircraft layer reports aircraft near the current view, or an explicit no-data/source error.
- Pan to another region and wait up to 15 seconds: aircraft query center changes.
- Select a ground object and open Street Level: KartaView imagery stays inside World Select.
- If KartaView has no imagery: World Select shows NO COVERAGE and does not open Google Maps.
- On mobile: Layers/Inspector/Street/Time remain bottom-sheet controls and do not permanently cover the globe.
