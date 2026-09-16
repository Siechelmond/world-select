# World Select v5.0 - Live Layer Foundation

## Purpose

v5.0 stops adding new surface area and repairs the live-data contract underneath Aircraft and Street imagery before the next feature expansion.

The reference pattern is the public God's Eye View runtime documentation: live flights have an explicit primary/fallback relationship, bounded coverage, stale-source handling and last-good retention rather than a collection of unrelated providers racing indefinitely.

## Aircraft changes

- Removed the four-provider race that had accumulated repeated 403/429/timeout behavior.
- Fixed the ADSB.lol regional endpoint to the documented v2 route:
  `/v2/lat/{lat}/lon/{lon}/dist/{radius}`.
- Default provider is ADSB.lol regional open data.
- Optional OpenSky integration is supported server-side:
  - OAuth client credentials when `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` are configured.
  - Anonymous OpenSky is opt-in only via `OPENSKY_AUTH_MODE=anonymous`.
  - With OAuth, OpenSky is primary and ADSB.lol remains the bounded regional fallback.
- OpenSky snapshots older than two minutes are not represented as fresh.
- Last successful regional Cloudflare snapshot is retained and returned as `stale/degraded` when the live provider temporarily fails.
- Client consumes explicit feed metadata instead of inferring health from rendered entities.
- Stale aircraft are not dead-reckoned and re-labelled as fresh estimated motion.
- `Degraded` is again a first-class visible layer state whenever last-good aircraft are retained after a refresh failure.

## Street changes

- KartaView request now respects its documented `radius` range: 500 m maximum.
- Previous World Select builds requested 1500 m, outside the current documented contract.
- Returned KartaView photos are ordered by distance to the requested point when coordinates are available.
- Google -> KartaView fallback keeps the reason visible, and `NO COVERAGE` now states that the fallback searched the documented 500 m radius.
- Street remains in the main World Select viewport, not a new browser page.

## Regression gate

`npm run verify:contracts`

The gate currently checks:

1. documented ADSB.lol route is present;
2. legacy `/v2/point/` route is absent;
3. Aircraft provider contract is limited to OpenSky + ADSB.lol;
4. stale/degraded cache path exists;
5. feed metadata reaches the UI;
6. stale aircraft are not projected;
7. KartaView radius is contract-valid;
8. `Degraded` remains visible in the layer UI.

## UAT after Cloudflare deployment

### Aircraft

1. Enable Aircraft over Vienna/central Europe.
2. First valid snapshot should show aircraft without waiting through multiple 403/429 provider chains.
3. Layer subtitle must show the actual provider (`adsb.lol` by default, `opensky` when configured and selected).
4. If a background refresh later fails after a valid snapshot, aircraft remain visible and state changes to `Degraded`.
5. If no valid snapshot has ever loaded, state is `Unavailable` with explicit Retry.
6. Plane glyphs and selected-only trail/label remain intact.

### Street

1. Open Street at a Google-covered point: Google panorama remains in the main viewport.
2. At a point where Google cannot return a panorama, KartaView is attempted automatically.
3. If KartaView has imagery within 500 m, the nearest returned image is shown.
4. If it has none, `NO COVERAGE` is truthful and the search radius is not silently expanded beyond the documented API contract.

## Not changed in v5.0

- Earthquake feed/rendering.
- Satellite/CelesTrak/SGP4 path, including the existing ISS presentation.
- TomTom Traffic rendering.
- Cloudflare environment settings or secrets.
- Google key configuration.
- Stock Select / Pool Select or any other project.
