# World Select v4.3 — Stabilization Bundle

Scope: stabilize the current v4.2.x feature set before adding Google services.

## Included

- Traffic: keeps TomTom Orbis v2, raises overlay contrast/opacity, reports tile failures as Degraded instead of falsely remaining Live.
- Aircraft: provider cooldown for HTTP 429/401/403 and transient failures, staggered first-success fallback, edge cache, last valid aircraft remain visible when a refresh fails.
- Aircraft rendering: regional footprint remains explicit; labels/trails remain selected-aircraft only; bounded interpolation remains display-only and marked ESTIMATED.
- Satellites: SGP4 motion remains CALCULATED; trails are now selected-satellite only, reducing world-view rendering load; point size is camera LOD-aware.
- Layer state: adds Degraded state between Live and Unavailable; background failures do not erase last valid data.
- Mobile: keeps bottom-sheet workflow, slightly reduces card density and constrains sheet height.

## Guardrails

- No Google APIs added.
- No database, deployment, secret or environment changes.
- No change to the working USGS earthquake behavior.
- No fabricated aircraft routes or positions.
