# World Select v4.2 — Lazy Layers & Layer Load Status

## Goal
Heavy live layers must not all start on page load. The user explicitly activates each layer. Once loaded, multiple layers remain active together.

## State model
Each layer uses the same visible state machine:

`OFF -> LOADING -> LIVE | ERROR`

- **OFF**: no fetch and no rendering work for that layer.
- **LOADING**: indeterminate progress bar; no fake percentage.
- **LIVE**: layer remains active while other layers may be loaded as well.
- **ERROR**: concise user-facing state plus Retry.

## Layers
- Earthquakes: loads from USGS only after user activation.
- Satellites: fetches CelesTrak GP/TLE only after user activation; propagation continues locally while active.
- Aircraft: starts viewport ADS-B loading and refresh only after activation; stops requests when disabled.
- Traffic: status/provider check starts only after activation; no automatic startup request.

## Mobile
The same state bar is shown in the Layers bottom sheet. No permanent cards are added over the globe.

## Performance rule
Lazy loading delays expensive work; it does **not** limit the user to one active layer. Loaded layers can operate concurrently.
