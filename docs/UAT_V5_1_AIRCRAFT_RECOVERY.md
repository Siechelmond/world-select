# World Select v5.1 - Aircraft Recovery

## Evidence from v5.0 production status probe

Production returned:

- OpenSky selected first, proving `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` were visible to the function.
- OpenSky failed with `timeout`.
- adsb.lol fallback returned HTTP 403.
- No last-good cache existed, therefore the layer correctly showed `Unavailable` rather than `Degraded`.

This means the Cloudflare environment configuration was not the primary defect. The live provider path was.

## v5.1 changes

- OpenSky OAuth token timeout increased from 5s to 12s.
- OpenSky states timeout increased from 5s to 12s.
- If only the OAuth token broker fails/times out, World Select now falls back to OpenSky anonymous mode before abandoning OpenSky.
- Without OpenSky credentials, `auto` mode now uses supported anonymous OpenSky instead of silently disabling the provider.
- OpenSky remains first; adsb.lol remains bounded regional fallback.
- adsb.lol requests identify World Select with a stable User-Agent.
- Status diagnostics now report provider phase (`oauth-token`, `states`, `snapshot`) and elapsed milliseconds without exposing credentials.
- Existing last-good cache and `Degraded` semantics remain unchanged.

## Production probe after deploy

Open:

`/api/aircraft?lat=48.2082&lon=16.3738&radius=220&mode=status`

Expected successful shapes include:

- `provider: "opensky"`, `authMode: "oauth"`, non-empty `ac`
- or `provider: "opensky"`, `authMode: "anonymous-fallback"` if OAuth token acquisition is temporarily slow
- or bounded `adsb.lol` fallback if OpenSky truly fails but adsb.lol accepts the edge request

If OpenSky still fails, `attempts[].phase` now identifies whether the timeout is at the OAuth broker or the actual state-vector endpoint.
