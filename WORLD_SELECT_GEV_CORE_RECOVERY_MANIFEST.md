# WORLD SELECT — GEV CORE RECOVERY MANIFEST

Date: 2026-09-17
Base: `world-select-v6-foundation` @ `5c1d7e8c00d62615e128bfebab2740dd018a8d13`
Target: same branch only. `main` must remain untouched until explicit release approval.

## Functional bundle

- Global-first OpenSky aircraft acquisition with bounded regional fallbacks and last-good behavior.
- Dedicated adsb.lol military feed plus ALL/CIV/MIL filtering.
- Aircraft class-specific glyphs, interpolation, bounded trails and follow.
- Satellite glyph LOD, ISS hero rendering, true baked orbit rings and faster selected propagation.
- TomTom traffic fail-soft behavior: configured keys may still attempt viewport tiles when the status probe fails.
- Street provider hard timeouts and parallel Google/KartaView coverage lookup.
- Keyless Esri/OSM map boot; no automatic Google map-tile consumption.
- Keyless OSM/FOSSGIS WALK/DRIVE/BIKE directions and camera route flythrough.
- QA/UAT coverage for the above.

## Provider truth rules

- OpenSky global success may be described as worldwide/global feed scope.
- adsb.lol point fallback is regional only and must never be labeled global.
- Military feed provenance remains adsb.lol.
- A failed provider after last-good data may become DEGRADED; a cold failure is UNAVAILABLE.
- Traffic failure is isolated from basemap state.
- Route service failure must not be replaced by a straight line presented as walking/driving/cycling.

## Cost guard

Google map tiles are not loaded automatically at application boot. Google remains an explicit/on-demand capability (currently Street View); the default globe is keyless Esri/OSM.

## QA

Run:

```sh
npm run qa:f1
```

Browser/Cloudflare provider UAT is still mandatory after deployment.
