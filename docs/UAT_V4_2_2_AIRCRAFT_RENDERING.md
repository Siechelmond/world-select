# World Select v4.2.2 — Aircraft rendering correction

## Why this change exists
v4.2.1 rendered every aircraft with a label and trail while the provider query only covered a regional radius around one map-center point. At continent scale this looked like a false dense cluster and caused poor performance.

## v4.2.2 rules
- Aircraft positions remain provider-derived ADS-B latitude/longitude values.
- The regional query footprint is drawn on the globe so coverage is explicit.
- No mass labels: only the selected aircraft gets a callsign label.
- No mass trails: only the selected aircraft gets a trail.
- At high altitude aircraft use small points only.
- Dead-reckoning animation runs only when zoomed closer than 900 km, or for the selected aircraft.
- At continent scale points represent the latest observed ADS-B sample and update on provider refresh.
- Multiple loaded layers remain active concurrently.

## UAT
1. Load Aircraft at continent view: points should be readable, not a wall of labels.
2. Verify points are constrained to the visible yellow query footprint.
3. Select one aircraft: only it gets label/trail.
4. Zoom below 900 km: aircraft motion should become visible between provider samples.
5. Load Satellites or Earthquakes too: Aircraft stays active.
