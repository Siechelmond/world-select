# World Select v4.2.1 — Stable Layer State

## Goal
Prevent user-hostile load/error/reload loops after a manual layer activation.

## State rule
`OFF -> LOADING -> LIVE | UNAVAILABLE`

`UNAVAILABLE` is terminal until the user explicitly presses **Retry** or switches the layer off and on again.

## Aircraft
- Initial failure does not auto-retry.
- Camera movement does not bypass an error hold.
- A Retry click explicitly releases the hold and starts one new load attempt.
- After the first successful load, periodic background refresh remains enabled.
- Background refresh failures never return the visible layer to `Loading` or `Unavailable`.
- Last known aircraft remain visible and the layer reports a degraded/live-refresh-delayed message.

## UAT
1. Enable Aircraft with an unavailable provider.
2. Observe one `Loading` transition followed by stable `Unavailable`.
3. Wait at least 30 seconds: no automatic re-entry into `Loading`.
4. Move the globe: no automatic retry while the layer is held in `Unavailable`.
5. Press Retry: exactly one new load attempt starts.
6. After a successful load, simulate a refresh failure: aircraft remain visible and the card does not flicker.
