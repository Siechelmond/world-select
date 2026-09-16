> Current stabilization: **v5.0 Live Layer Foundation**

# World Select

World Select is an isolated browser-based spatial-intelligence prototype for exploring Earth, orbit and the Solar System through normalized spatial entities.

## Current MVP

- Cesium 3D Earth using OpenStreetMap imagery.
- Live USGS M2.5+ earthquakes from the past day.
- Current CelesTrak space-station GP/TLE data propagated with SGP4.
- Earth / Space mode.
- Sun + eight major planets using NASA/JPL approximate planetary-position formulae.
- Time control ±365 days.
- Shared inspector with source/provenance and `OBSERVED` / `CALCULATED` state.
- Static-export friendly; no database and no secret API key required.

## Local start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Static build

```bash
npm run build
```

The static export is written to `out/`.

## Data sources

- USGS Earthquake Hazards Program
- CelesTrak GP orbital elements
- NASA/JPL Solar System Dynamics approximate planetary positions

## Guardrail

This repository is fully isolated. World Select must not modify or depend on Stock Select, Pool Select, their repositories, deployments, databases, secrets, or production environments unless explicitly authorized in a later decision.

## v3 — Mobile Explore, Street Level, Aircraft

World Select v3 adds a mobile-first control model, a keyless Street View link-out and a bounded aircraft layer around the current Earth view center.

- Mobile: Layers, Inspector and Time are bottom sheets opened from a compact dock.
- Street level: opens Google Maps Street View at the selected Earth entity or current map center using a Maps URL; no Google API key is stored.
- Aircraft: ADSB.lol observations within a bounded radius of the current map center, refreshed while the layer is active.
- Provenance remains explicit: aircraft and earthquakes are `OBSERVED`; satellite and planet positions are `CALCULATED`.
- No database or secret key is introduced in v3.

See `docs/MVP_V3_MOBILE_EXPLORE.md` for scope and acceptance criteria.

## v3.1 stabilization

v3.1 moves CelesTrak, ADSB.lol and KartaView requests behind Cloudflare Pages Functions in `functions/api/`, adds continuous SGP4 satellite motion, correct globe occlusion for earthquake markers, per-layer diagnostics, and an in-app KartaView street-level viewer. See `docs/UAT_V3_1_STABILIZATION.md`.

## v4 — Ground / Traffic / Aircraft Motion

World Select v4 adds a mobile-first Earth-to-Ground workflow, German geographic labels, observed aircraft trails with live visual motion/follow, a broader bounded satellite catalogue, and an optional live traffic overlay.

### Traffic configuration

Traffic is deliberately fail-safe. No traffic is invented when no provider is configured. To enable live TomTom Traffic Flow in Cloudflare Pages, add the encrypted project secret:

`TOMTOM_API_KEY=<your TomTom Traffic API key>`

Then redeploy. The browser never receives the key; raster traffic tiles are proxied through `/api/traffic`.

See `docs/MVP_V4_GROUND_TRAFFIC.md` for acceptance criteria and data semantics.


## v4.1 Performance

Performance pass: parallel aircraft provider fallback, viewport request quantization, stale aircraft retention, bounded trails, and mobile-specific motion update rates. See `docs/PERFORMANCE_V4_1.md`.


## v4.2 — Lazy Layers
Heavy live layers now load only after an explicit user action and expose visible OFF / LOADING / LIVE / ERROR status bars. Multiple loaded layers continue to run together. See `docs/PERFORMANCE_V4_2_LAZY_LAYERS.md`.


## v4.2.1 — stable layer states

Failed manual layer loads stay in `Unavailable` until the user explicitly retries or toggles the layer. Successful Aircraft loads continue background refresh without visible Loading/Error flicker.

## v4.2.2 Aircraft rendering correction
Aircraft is now an explicit regional ADS-B layer rather than a misleading pseudo-global cloud. The query footprint is visible, mass labels/trails are removed, and detailed motion is enabled at useful zoom levels or for the selected aircraft. See `docs/UAT_V4_2_2_AIRCRAFT_RENDERING.md`.


## v4.2.3 aircraft latency hotfix

Aircraft proxy now returns the first successful provider immediately, hedges fallbacks with short delays, and uses Cloudflare edge cache for recent regional snapshots.

## v4.2.5 traffic rendering

Traffic rendering now requests TomTom Orbis raster flow tiles from zoom level 0 upward, using an explicit Web Mercator tiling scheme. The Traffic layer status shows `Live` rather than an artificial count of one.

## v4.3 stabilization
See `docs/UAT_V4_3_STABILIZATION.md`.


## v4.4 Explore bundle
- Aircraft plane glyphs with heading
- TomTom traffic incidents overlay alongside flow
- Lazy in-app Google Street View with KartaView fallback
- See `docs/UAT_V4_4_EXPLORE.md`


## v4.5 — Integrated Ground Bundle
- Aircraft recovery: coarser regional edge snapshots, stale-cache fallback, longer provider timeouts, no permanent client lockout after one transient failure.
- Aircraft keeps plane glyphs, selected-only label/trail, bounded dead-reckoning between observed ADS-B samples.
- Traffic uses the TomTom Orbis `dark` relative-flow style plus incident overlay for a clearer green/amber/red operational view.
- Google Street View now takes over the main Earth viewport instead of opening as a modal card; KartaView remains an in-app fallback.
- Adds lightweight session annotations / location markers without introducing a database.
- Existing earthquake and satellite data paths remain unchanged.


## v5.0 - Live Layer Foundation

- Repairs the Aircraft provider contract rather than adding another fallback.
- ADSB.lol now uses the documented `/v2/lat/{lat}/lon/{lon}/dist/{radius}` route.
- Optional OpenSky OAuth support is server-side; without credentials World Select defaults to ADSB.lol only.
- Aircraft responses carry explicit provider, coverage, source-age, cached/stale and degraded metadata.
- Last-good Aircraft data remains visible as `Degraded` after refresh failures.
- Stale Aircraft are never projected as fresh motion.
- KartaView fallback now respects its documented 500 m radius and reports truthful `NO COVERAGE`.
- Adds `npm run verify:contracts` as a regression gate before subsequent bundles.
- See `docs/UAT_V5_0_LAYER_FOUNDATION.md`.
