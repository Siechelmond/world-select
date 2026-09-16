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
