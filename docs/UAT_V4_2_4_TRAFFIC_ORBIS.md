# World Select v4.2.4 — Traffic Orbis Fix

## Scope

Traffic-only stabilization. No changes to earthquake, satellite or aircraft rendering.

## Changes

- Migrated TomTom Traffic raster flow from legacy Traffic Maps v4 endpoint to TomTom Orbis Traffic Flow v2.
- API key is sent server-side with the `TomTom-Api-Key` header.
- `/api/traffic?mode=status` now performs a real TomTom probe instead of merely checking whether the environment variable exists.
- UI marks Traffic `Live` only when the deployed key is both present and accepted by TomTom.
- Upstream HTTP status is returned in diagnostics without exposing the secret.
- Tile coordinate validation now also checks the valid x/y range for the requested zoom level.

## UAT

1. Traffic starts Off.
2. User activates Traffic.
3. Loading appears once.
4. If TomTom accepts the key: state becomes Live and flow tiles appear.
5. If TomTom rejects the key: state becomes Unavailable and remains stable until explicit Retry.
6. No secret value is ever returned to the browser.
