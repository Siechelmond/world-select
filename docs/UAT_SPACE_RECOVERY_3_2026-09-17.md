# World Select — UAT Space Recovery 3

Target: `world-select-v6-foundation`

## Earth non-regression first

1. Load EARTH.
2. Earthquakes and Satellites become live.
3. Aircraft remains clickable on EARTH even if the time slider is historical; enabling it returns to NOW.
4. Traffic attaches tiles before the advisory status probe completes; probe failure may show DEGRADED but must not suppress already loadable tiles.
5. Street remains reachable from a selected earthquake, satellite or aircraft.

## ISS live

1. Hover ISS for about 500 ms.
2. `ISS · LIVE 4K` card appears.
3. Player is muted/autoplay-capable.
4. Card explains that a black frame can be the Earth night side or signal loss.
5. Leaving ISS removes the hover card.

## Space Explorer

1. Enter SPACE.
2. Solar System appears with the 8 planets.
3. Click Jupiter: dedicated Jupiter system opens with Io, Europa, Ganymede and Callisto.
4. Click a moon: Inspector switches to that moon and shows parent/orbit/model disclosures.
5. Repeat for Saturn; Titan and other featured moons are visible.
6. Use mouse wheel or +/- to travel outward: Planet System -> Solar System -> Kuiper Belt -> Milky Way.
7. In Kuiper Belt view, Pluto/Haumea/Makemake/Eris are selectable; disclosure says density is illustrative.
8. In Milky Way view, Solar System / Orion Spur marker is visible; disclosure says view is schematic.
9. Return to EARTH and confirm the persistent Earth runtime is intact and layer selections still operate.

## Acceptance

GO when new Space views work and EARTH behavior from Recovery 2/2A is unchanged. Any Earth regression is a NO-GO.
