# World Select v4.4 — Explore Bundle

## Scope
Bundled enhancement pass on top of v4.3. Existing earthquake behavior and core architecture are unchanged.

## Aircraft rendering
- Replaces generic point markers with lightweight airplane-shaped SVG billboards.
- Billboard rotates from the reported ADS-B track heading.
- Selected aircraft is larger and highlighted; label and observed trail remain selected-only.
- Existing regional query, provider cooldown, last-valid-data behavior and bounded motion projection remain in place.

## Traffic
- Existing TomTom Orbis v2 flow overlay remains.
- Adds a second TomTom Orbis v2 raster incident overlay through the same server-side API-key proxy.
- Both layers remain lazy and are removed together when Traffic is switched off.

## Street level
- Google Street View becomes the preferred in-app street provider when `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` exists at build time.
- Google is loaded lazily only when Street is opened.
- Nearby panorama lookup uses the selected entity or current map center.
- If Google is unavailable or has no nearby panorama, World Select falls back to KartaView.
- User can switch between Google Street View and KartaView from the street panel.
- Mobile keeps Street View inside the existing bottom-sheet-sized viewer.

## Required Google configuration
The implementation is code-complete but feature-gated. To activate Google Street View, the deployment must provide:

`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`

The key is client-visible by design for Maps JavaScript API usage. Restrict it in Google Cloud to the World Select HTTP referrer(s) and only required Google Maps Platform APIs.

## UAT
1. Aircraft enabled: airplane glyphs appear instead of dots and rotate with track heading.
2. Select an aircraft: larger highlighted glyph, label and trail only for selected aircraft.
3. Traffic enabled: flow colors plus incident overlay coexist with aircraft and satellites.
4. Street with Google key: interactive 360 panorama opens inside World Select.
5. Google no-coverage/error: KartaView fallback remains usable.
6. Mobile: Layers / Inspector / Street / Time remain usable without permanent obstruction.
