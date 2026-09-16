# World Select v4.5 — Integrated Ground Bundle

## Purpose
Bundle the outstanding v4.4 regression and the next visible product improvements without introducing new infrastructure.

## Aircraft recovery
- Keeps the airplane glyph introduced in v4.4.
- Cloudflare proxy now uses a coarse regional snapshot cache so small camera moves reuse the same recent feed instead of forcing a fresh provider call.
- Live providers are hedged with longer bounded timeouts.
- When providers fail after a successful regional snapshot, the proxy can return that snapshot as degraded/stale instead of dropping the layer to zero.
- The client no longer permanently blocks the Aircraft layer after one transient failed first request. Manual Retry remains available; no tight retry loop is introduced.
- Motion remains bounded display-only dead-reckoning between observed ADS-B samples.

## Traffic
- Existing TomTom Orbis v2 flow + incidents remains server-key-proxied.
- Uses the `dark` relative-flow raster style so free-flow / slowing / congestion are visually separated on the dark globe.
- Flow and incidents stay lazy and can coexist with Aircraft and Satellites.

## Ground / Street
- Google Street View is no longer presented as a centered modal card.
- Opening Street switches the main viewport to the panorama while retaining World Select chrome and a single close action back to Earth.
- KartaView remains an in-app fallback if Google is unavailable or has no panorama near the target point.
- Google remains lazy and only loads after the user opens Street.

## Additional video-aligned capability
- Adds local session annotations: the user can mark the selected/current Earth location with a named pin.
- This is intentionally local/session-only; no database or server persistence is introduced.

## UAT
1. Aircraft ON: first successful response renders airplane glyphs and a nonzero count.
2. If a later refresh fails, last valid aircraft stay visible and layer becomes Degraded rather than 0.
3. Selecting an aircraft shows its label/trail; Follow continues to work.
4. Traffic ON: green/amber/red relative flow and incident graphics can coexist with Aircraft.
5. Street: Google panorama occupies the main viewport, not a modal; close returns to the globe.
6. Google no coverage: KartaView fallback remains inside the app.
7. Mark location creates an orange annotation pin on Earth.
8. Earthquakes and satellite/ISS behavior remain unchanged.
9. Mobile: main viewport remains usable; Layers/Inspector/Time still open from the dock.
