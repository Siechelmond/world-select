# World Select v4.1 — Performance Pass

## Scope

v4.1 changes performance and resilience only. No new product layer is introduced.

## Changes

- Aircraft providers are queried in parallel in the Cloudflare Pages Function.
- Each upstream aircraft provider has a 3.5 second timeout.
- Aircraft responses use short edge caching plus `stale-while-revalidate`.
- Client keeps the last successful aircraft set during transient refresh failures.
- Aircraft viewport queries are quantized so tiny camera moves do not create a new request.
- Aircraft search radius is reduced automatically when the camera is near ground level.
- Aircraft observed refresh interval is 15 seconds; interpolated motion remains visible between observations.
- Satellite motion ticks at 1 second desktop / 2 seconds mobile.
- Satellite trail history is capped at 30 points desktop / 10 points mobile.
- Satellite trail points are only appended after meaningful movement.
- Aircraft trails are capped at 30 points desktop / 12 points mobile.

## UAT

1. Open World Select and confirm globe interaction remains responsive while satellites are active.
2. Pan the globe slightly several times; aircraft should not restart a fetch for every tiny move.
3. Aircraft should normally appear within a few seconds rather than waiting for sequential provider fallbacks.
4. Temporarily failed aircraft refreshes must not clear already visible aircraft.
5. On mobile, compare scrolling/rotation with satellite and aircraft trails enabled.
6. Verify satellite and aircraft movement remains visible despite lower mobile update/trail density.
