# World Select — GEV Recovery 2 UAT

## Scope

This bundle is a bounded follow-up to commit `3b61dfcc0d9ef6346e2d66fbce583e7f8f683166`. It fixes runtime-state regressions found in preview UAT without replacing the F1 persistent viewer.

## Acceptance

1. Aircraft starts as **Loading / Connecting** during the initial provider grace instead of immediately red.
2. Civilian and military source snapshots are retained independently. A military refresh cannot erase civilian last-good records and vice versa. `ALL` is the deduplicated merge.
3. Traffic imagery attaches immediately and the `/api/traffic?mode=status` probe is advisory. Probe timeout/failure may degrade the badge but must not suppress visible TomTom tiles.
4. Selecting an aircraft, earthquake or satellite does not remove Street access. Street opens at the selected entity/subpoint latitude+longitude and Back preserves the selection.
5. Aircraft inspector exposes callsign, ICAO24, squawk, emergency, last-seen age and an honest route placeholder until a separate route-enrichment source is added.
6. ISS hover for ~500 ms opens a muted Sen SpaceTV-1 YouTube live preview. Leaving the ISS removes the player. No stream is loaded on normal boot.
7. Layer boot is staged so the keyless basemap can become interactive before Aircraft/Traffic provider work.

## Do not claim

- A retained civilian snapshot is not current merely because military refreshed.
- Regional ADS-B fallback is not worldwide civilian coverage.
- Origin/destination is not inferred from ADS-B when no enrichment source supplies it.
- The Sen stream may have routine signal gaps; its video is external media, while ISS position remains CelesTrak/SGP4.

## Preview checks

- Reload preview: Globe should paint before all provider layers finish.
- Aircraft: observe Connecting, then Live/Degraded; verify count does not oscillate between mutually exclusive Civil/Military source sets. Toggle ALL/CIV/MIL.
- Traffic: lines should be allowed to render even while status reads Degraded.
- Select aircraft/earthquake: Inspector must still show `Street near entity`; enter Street and return.
- Hover ISS deliberately for >500 ms: live 4K preview appears muted; casual fly-over should not start a player.
