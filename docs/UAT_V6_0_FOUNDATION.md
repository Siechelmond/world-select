# World Select v6.0 Foundation — UAT

## Scope

This bundle is a bounded foundation/stabilization pass. It does not deploy anything and does not add CCTV, vessels, fires, cockpit or voice yet.

### Changed

- Extracted persistent Cesium viewer creation/teardown and base-map ownership into `lib/cesium-viewer.ts`.
- Primary keyless base imagery is Esri World Imagery; OSM is fallback only.
- Globe overlay labels are English-first.
- Street now performs Google -> KartaView coverage preflight before hiding the globe.
- If neither Street provider has coverage, World Select stays on the globe and reports the condition non-blockingly.
- Street has an explicit `Back to Globe` action and restores the previous Cesium camera pose.
- Satellite `CORE` catalog now targets Stations, Visual, GPS, GLONASS, Galileo and GEO CelesTrak groups.
- Satellite `DENSE` is opt-in and adds a bounded Starlink shell.
- Existing Aircraft provider/gateway behavior, Traffic, Earthquakes and ISS rendering code were not rewritten.

## Desktop UAT

1. Load app and verify globe appears with satellite imagery and English overlay labels.
2. Enable Earthquakes: existing markers still render.
3. Enable Satellites in CORE: verify materially more objects than the old ~123 baseline when upstream data is available; zoom out enough to see higher-altitude GNSS/GEO objects.
4. Switch Satellites to DENSE: verify count increases and app remains responsive.
5. Select ISS: verify the existing ISS presentation remains visible and selectable.
6. Enable Traffic: verify TomTom tiles remain visible and Satellites/Earthquakes are unaffected.
7. At a known Street View location, choose Street: globe should hide only after coverage succeeds; `Back to Globe` must be visible.
8. Return to globe: verify the previous camera pose is restored.
9. At a location with no Google or KartaView coverage, choose Street: globe must remain visible; no blank/black Street screen is allowed.
10. If Aircraft remains unavailable because of upstream/gateway connectivity, confirm other layers remain usable and no false `Live` state is shown.

## Mobile UAT

- Repeat Street success/no-coverage/back flow.
- Verify layer panel remains usable with CORE/DENSE controls.
- Verify globe remains pannable/zoomable after closing Street.

## Intentionally not changed

- OpenSky/Render networking topology.
- Cloudflare project/environment variables.
- Cloudflare deployment configuration.
- Aircraft gateway credentials.
- CCTV, AIS vessels, FIRMS fires, radio, infrastructure, mission replay, detection, visual sensor modes or voice.
