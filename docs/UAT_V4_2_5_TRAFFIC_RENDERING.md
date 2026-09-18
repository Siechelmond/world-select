# World Select v4.2.5 — Traffic Rendering Fix

Scope is deliberately limited to TomTom traffic visualization.

## Fixed

- TomTom Orbis Traffic Flow remains behind the existing `/api/traffic` Cloudflare Pages Function.
- Cesium traffic imagery now supports zoom levels `0..20` instead of starting at level 4.
- Explicit Web Mercator tiling scheme matches TomTom/OSM raster tile coordinates.
- Traffic layer status no longer displays the misleading `Live · 1`; it displays `Live`.
- No Aircraft, Satellite, Earthquake, Street, lazy-load, mobile, or provider behavior was intentionally changed.

## UAT

1. Activate Traffic while in EARTH mode at Europe/world scale.
2. Status should become `Live` without a numeric count.
3. Major-road flow should become visible as TomTom colored transparent lines where TomTom has flow coverage.
4. Zoom toward a city/GROUND view; progressively more road flow should appear.
5. Turn Traffic off; overlay should disappear without affecting other active layers.
6. Turn other layers on together with Traffic; all loaded layers should remain active.
