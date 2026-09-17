# World Select v3.2 — Reliability UAT

## Confirmed from v3.1
- Earthquake anchoring/depth: PASS from owner UAT.

## v3.2 changes
- Satellite set changed from CelesTrak STATIONS (~20) to VISUAL (~100 brightest).
- Satellite positions remain SGP4-calculated every second at NOW; a short factual trail makes motion visible without speeding time up.
- Aircraft proxy keeps ADSB.lol primary and uses OpenSky bounding-box state vectors as fallback when primary fails.
- Street imagery search expanded to 1.5 km and now prefers processed/thumbnail KartaView URLs instead of raw placeholder URLs.

## UAT
1. Satellites: expect materially more than 20 when CelesTrak is available.
2. Satellites: leave Earth view open 30-60 s; cyan trails should extend and points should progress along them.
3. Aircraft: verify non-zero count around a populated European view; layer must show provider/source in selected aircraft.
4. Street: select an urban point and open Street; expect imagery where KartaView has coverage, otherwise explicit NO COVERAGE.
5. Earthquakes: regression check only; points must stay ground-anchored and occluded by globe.
