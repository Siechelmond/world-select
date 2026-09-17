# WORLD SELECT — UAT RECOVERY 5

## 1. Aircraft render-crash regression — P0
1. Open EARTH/GROUND.
2. Select an aircraft.
3. Click **Follow aircraft**.
4. Leave it running across at least two provider refreshes.

PASS:
- No Cesium modal `Rendering has stopped`.
- No `t.getType is not a function`.
- Selected aircraft can retain/follow its observed session trail.

## 2. Aircraft LOD / regional coverage
1. Use ALL at continent/globe scale.
2. Zoom toward Europe and then out again.

PASS:
- Far view no longer becomes an unreadable carpet of full-size white aircraft glyphs.
- More aircraft resolve progressively as camera approaches.
- Regional civilian fallback has a subtle coverage boundary when metadata supplies the region.
- MIL remains yellow; CIV remains white.

## 3. Fresh vs stale semantics
Select an aircraft that shows `Last seen` near 0 seconds while the overall layer is DEGRADED.

PASS:
- Individual aircraft may show `OBSERVED` even while ALL is `DEGRADED`.
- Cached/explicitly stale provider snapshots still show `STALE`.

## 4. Traffic diagnostic
If Traffic is unavailable, read the status text.

PASS:
- Concrete reason is visible (for example missing Cloudflare key or upstream HTTP failure), not only a generic `Live source unavailable`.
- Existing basemap remains usable.

## 5. Street diagnostic / no freeze
Try Street in a known urban location and near a selected entity.

PASS:
- If Google/KartaView succeeds, Street opens.
- If both fail, Globe stays interactive.
- Toast reports provider context rather than silently claiming only `no imagery`.

## 6. SPACE TIME bar
Open SPACE at a desktop width similar to prior UAT screenshots.

PASS:
- PLAY / 1D/S / 7D/S / 30D/S / NOW do not overlap.
- On narrower desktop width, controls reflow instead of colliding.
- Planet/moon time animation remains functional.

## 7. Milky Way realism pass
Open SPACE → MILKY WAY.

PASS:
- Arms appear more diffuse and less like clean diagram strokes.
- Central bulge has greater depth.
- Dust lanes remain visible.
- Orion Spur and `YOU ARE HERE` remain readable.
