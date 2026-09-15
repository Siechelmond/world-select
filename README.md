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
