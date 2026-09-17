# World Select v6.0.1 Foundation — UAT correction

## Why this follow-up exists

Preview UAT on 2026-09-17 exposed three concrete problems:

1. Street testing was confusing because a selected satellite could silently redirect the lookup to its ground subpoint.
2. The yellow aircraft query-radius ellipse looked like aircraft content although no aircraft payload had loaded.
3. CORE and DENSE could look identical when the STARLINK upstream group was unavailable.

The Ground view also lacked enough road/city context for practical navigation.

## Changed

- Street lookup is now always centered on the current map center, not the currently selected satellite/aircraft.
- Inspector action is explicitly labelled `Street at map center`.
- Annotations still use the selected entity position when appropriate.
- Ground zoom switches to Esri World Street Map below 650 km camera height, while Earth remains on World Imagery.
- Removed the user-visible aircraft query-radius ellipse.
- Aircraft cold failures now keep retrying in the background with non-overlapping bounded cycles instead of stopping permanently after the first failed load.
- DENSE now adds IRIDIUM-NEXT + ONEWEB + STARLINK, so it can still expand when one constellation upstream is temporarily unavailable.
- Satellite endpoint now exposes successful and failed group names in response headers for diagnosis.

## Desktop UAT

1. Open the branch preview and reload once.
2. Click `GROUND` over a populated area: road/city basemap detail should replace the high-altitude imagery view.
3. Without selecting a satellite, use Street at a known covered city location.
4. Select a satellite, then click `Street at map center`: lookup must remain at the current map center rather than jump to the satellite subpoint.
5. Enable Aircraft: no yellow query-radius circle should appear. If upstream is still unavailable, the card may remain Unavailable and retry automatically.
6. Enable Satellites CORE and note the count.
7. Click DENSE and wait for refresh: count should increase when at least one additional constellation group is available. If not, inspect satellite response headers for failed groups before treating it as a UI bug.
8. Verify Earthquakes and existing ISS presentation still work.
9. Verify Traffic remains independent. If Traffic is unavailable only in branch preview, check Preview-environment provider configuration separately from code.

## Known environment caveat

A Google browser API key restricted only to `https://world-select.pages.dev/*` will not authorize the branch hostname `https://world-select-v6-foundation.world-select.pages.dev/*`. Google Street View therefore cannot be fully validated on the branch preview until that preview referrer is permitted (or equivalent preview configuration is provided). KartaView remains independent.

## Intentionally not solved here

- OpenSky/datacenter egress problem.
- adsb.lol rate limiting.
- Cloudflare Preview environment secrets/variables.
- Google Cloud API key restrictions.
- CCTV, AIS, FIRMS, cockpit, radio, missions, detection or voice.
