# World Select v3 — Mobile Explore + Street Level + Aircraft

## Scope

v3 intentionally bundles three visible product improvements while keeping the data architecture bounded:

1. **Mobile-first controls** — the globe remains the primary surface; Layers, Inspector and Time become on-demand bottom sheets on small screens.
2. **Street-level entry** — any selected Earth entity, or the current Earth view center, can open the nearest Google Street View panorama using a Maps URL. This is a link-out and does not require a Google Maps API key.
3. **Aircraft layer** — live/near-live ADS-B observations are loaded from ADSB.lol around the current Earth view center and refreshed while the layer is active.

## Explicitly not included

- The pending v2 UAT rendering/motion patch is not merged into this package.
- No database.
- No user accounts.
- No embedded Google Street View SDK.
- No commercial traffic provider.
- No aircraft history persistence.

## Aircraft behaviour

- Source: ADSB.lol public API (ODbL 1.0).
- Query is bounded to a maximum 250 NM radius around the current view center.
- The client refreshes the active snapshot periodically.
- Aircraft are marked `OBSERVED`, never `LIVE` as a measurement guarantee.
- Aircraft are only available at `NOW`; historical time-slider positions are not fabricated.

## Mobile UX acceptance criteria

- On <= 780 px width the globe/space scene is unobstructed by default.
- Layers, Inspector and Time are opened from a bottom dock.
- Selecting an entity automatically opens Inspector.
- Street opens externally and does not require a secret key.
- Desktop layout remains available.

## Provenance

- Earthquakes: USGS / `OBSERVED`
- Aircraft: ADSB.lol / `OBSERVED`
- Satellites: CelesTrak + SGP4 / `CALCULATED`
- Planets: JPL approximate elements / `CALCULATED`
