# WORLD SELECT — RECOVERY 4 UAT

Target: `world-select-v6-foundation`

## 1. Non-regression smoke

1. Open EARTH.
2. Confirm Earthquakes still loads.
3. Confirm Satellites CORE still loads and ISS orbit/selection still works.
4. Hover ISS and confirm the live card behavior is unchanged.
5. Open SPACE and confirm existing planet -> moon-system interaction still works.

## 2. Aircraft filter truth

1. Enable Aircraft at NOW.
2. Read counts directly on `ALL`, `CIV`, `MIL`.
3. Click `MIL`: visible aircraft and status/count must describe Military only.
4. Click `CIV`: if civilian provider is unavailable, card must say unavailable/0 for CIV rather than inheriting Military's degraded/live state.
5. Click `ALL`: retained CIV + MIL sources must merge without 62/165-style source replacement oscillation.
6. Select an aircraft and confirm Follow + Street + session trail behavior still works.

## 3. Traffic

1. Enable Traffic over a known covered city.
2. If the active TomTom key accepts Orbis v2, tiles should render via Orbis.
3. If Orbis is rejected but the key accepts classic Traffic v4, tiles should render via v4 fallback.
4. If no key exists in preview environment, the reason should explicitly identify missing `TOMTOM_API_KEY` rather than a generic load failure.
5. Basemap must remain usable even when Traffic fails.

## 4. Street

1. Move to a dense urban area.
2. Click `Open street level here`.
3. Google searches 120/250/500 m before giving up.
4. If Google is denied by API-key/referrer policy, the error must be explicit and KartaView fallback must still run.
5. KartaView checks a 1000 m nearby-photo envelope.
6. If neither provider has usable imagery, Globe remains interactive and shows the existing non-blocking failure notice.
7. Repeat from a selected Earthquake/Aircraft/Satellite ground point.

## 5. Space TIME playback

1. Enter SPACE.
2. Select Jupiter or Saturn planet-system view.
3. Press PLAY.
4. Switch `1D/S`, `7D/S`, `30D/S` and confirm moons visibly advance around the planet.
5. Go back to SOLAR SYSTEM and confirm planets also advance.
6. Press PAUSE then NOW; time returns to present and movement stops.
7. Return to EARTH and confirm Space playback is stopped.

## 6. Milky Way

1. Navigate to MILKY WAY.
2. Confirm curved spiral-arm structure replaces the spoke-like view.
3. Confirm dark dust lanes, Galactic Center, Orion Spur and Solar System `YOU ARE HERE` marker are visible.
4. Confirm description still says the galaxy view is a context model, not a literal photograph/star-by-star map.
