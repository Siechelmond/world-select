# World Select v4 — Ground, Traffic, Aircraft Motion

## Scope

v4 consolidates the v3.1/v3.2 stabilization work and adds the next major experience layer instead of replacing it.

### Kept from v3.x
- earthquakes are anchored to their real coordinates and occluded by the globe
- satellite propagation remains SGP4-based and continues to expose provenance
- Cloudflare Pages Functions remain the browser-to-provider bridge
- mobile panels remain bottom-sheet/dock based
- street imagery remains in-app and optional

### New in v4
- `EARTH / GROUND / SPACE` navigation
- automatic ground-state recognition below ~120 km camera height
- curated German geographic labels for countries, cities and seas
- expanded multi-group satellite catalogue (visual, stations, weather, GNSS and a bounded Starlink sample)
- multi-provider aircraft fallback: ADSB.lol → airplanes.live → adsb.fi → OpenSky
- aircraft observed-position trail
- 1-second dead-reckoned visual movement between observed ADS-B refreshes
- aircraft follow mode using Cesium tracked entity
- Traffic Flow overlay wired through `/api/traffic` and TomTom raster flow tiles

## Data semantics

Aircraft source points are OBSERVED. The map may visually project an aircraft between two provider refreshes from its last speed/track; that display position is marked ESTIMATED in the Inspector. The trail contains observed samples only.

Satellite positions are CALCULATED from current CelesTrak GP/TLE data using SGP4.

Traffic is unavailable unless the Cloudflare secret `TOMTOM_API_KEY` is configured. World Select must show this as unavailable and must not synthesize traffic.

## Mobile acceptance criteria

- the globe is the default full-screen content
- no permanent side card may block the central globe on phone widths
- Layers, Inspector, Street and Time remain available through the bottom dock
- Earth/Ground/Space controls fit within the mobile top bar
- aircraft follow can be started/stopped from the mobile Inspector

## v4 UAT

1. Zoom from globe to Vienna: German labels should become progressively visible.
2. Press GROUND: camera should move to street/city scale without leaving World Select.
3. Aircraft layer: provider should return aircraft in a busy region; markers should move between refreshes.
4. Select an aircraft: observed trail should remain behind it; Follow Aircraft should track it.
5. Satellites: substantially more than the former ~20 station objects should load and move.
6. Traffic without key: clear unavailable status, no fake traffic.
7. Traffic with `TOMTOM_API_KEY`: raster flow overlay should appear on road networks.
8. Phone width: globe stays usable; panels open only on demand.
