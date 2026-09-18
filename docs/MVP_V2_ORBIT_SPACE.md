# World Select — MVP V2: Orbit + Space

## Scope

This increment extends the first Earth/earthquake vertical slice with an Orbit and Solar System foundation while preserving the hard project-isolation guardrails.

### Added
- Earth / Space mode switch.
- Current CelesTrak `STATIONS` GP/TLE feed.
- SGP4 propagation in the browser via `satellite.js`.
- Satellite markers on the Cesium globe, including ISS/CSS-related station objects.
- Shared normalized `SpatialEntity` inspector for earthquakes, satellites and celestial bodies.
- Sun + eight major planets in a dedicated Solar System view.
- Planet positions calculated from NASA/JPL Solar System Dynamics approximate Keplerian elements (Table 2a, valid 3000 BC–3000 AD).
- Time control from -365 to +365 days.
- Explicit provenance and `OBSERVED` vs `CALCULATED` state labels.

## Accuracy / product rule

The Solar System view is a visualization, not a precision-navigation product. Planet coordinates use JPL's published lower-accuracy formulae. Orbital distances are logarithmically scaled for legibility. Satellites are propagated from the current GP/TLE state using SGP4, so their display is calculated from recent orbital elements rather than a direct observation at the displayed instant.

For future high-precision planet, Moon and spacecraft ephemerides, use a server-side/cached NASA/JPL Horizons or NAIF/SPICE integration and preserve provenance in the entity model.

## Deferred
- Moon high-precision ephemeris.
- Spacecraft trajectories.
- Satellite trails and ground tracks.
- Aircraft and traffic.
- Database / historical persistence.
- AI command layer.
