# World Select

World Select is a browser-based spatial intelligence platform that combines real-world and space data on one interactive globe.

## MVP v1

The first proof is deliberately bounded:

1. interactive 3D Earth
2. pluggable layer model
3. real earthquake data from the USGS public GeoJSON feed
4. selectable spatial entities
5. inspector with source / timestamp / data state
6. focus / tracking foundation
7. no database and no secret API keys

Later layers can add aircraft, ships, satellites, traffic, cameras, fires/weather, orbit and solar-system objects without changing the core entity contract.

## Architecture

`Source -> Adapter -> SpatialEntity -> Layer store -> Globe -> Inspector / Tracking`

See `docs/ARCHITECTURE.md` and `docs/MVP_V1.md`.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Current external dependencies

- Next.js / React
- CesiumJS loaded from the pinned Cesium CDN build (v1.145.0)
- USGS public earthquake GeoJSON feed

No Cesium ion token is required for MVP v1 because the globe uses Cesium's default ellipsoid and OpenStreetMap imagery.

## Isolation

`PROJECT_GUARDRAILS.md` is binding. World Select must not mutate any other repository, deployment, or database.
