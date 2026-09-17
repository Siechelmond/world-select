# World Select v5.2 — Aircraft Gateway

## Goal
Route aircraft retrieval through an optional external gateway when `AIRCRAFT_GATEWAY_URL` is configured, avoiding the repeatedly observed Cloudflare Pages -> OpenSky states timeout.

## Runtime order

With `AIRCRAFT_GATEWAY_URL`:
1. external aircraft gateway (OpenSky OAuth, cached)
2. adsb.lol direct fallback
3. last valid Cloudflare edge snapshot => DEGRADED

Without the gateway variable, the v5.1 direct OpenSky -> adsb.lol path remains available.

## Acceptance
- Gateway URL never comes from request input.
- OpenSky credentials remain server-side.
- A successful gateway snapshot renders immediately.
- A failed refresh keeps the last valid snapshot and returns degraded state.
- Status mode reports `gateway` as an attempt without exposing secrets.
- Direct Cloudflare -> OpenSky is skipped when the gateway is configured.
