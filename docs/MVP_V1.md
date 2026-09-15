# World Select — MVP v1

## Goal

Prove the vertical slice before adding breadth:

**3D globe -> real external data -> normalized entities -> click -> inspector -> focus**

## Included

- full-screen Cesium 3D globe
- OpenStreetMap imagery
- USGS M2.5+ earthquake feed, past day
- layer on/off control
- entity count
- point selection
- details inspector
- provenance and observed timestamp
- explicit `OBSERVED` state
- camera focus action
- responsive UI shell

## Not included yet

- user accounts
- database
- aircraft
- ships
- satellites
- traffic
- cameras
- weather/fires
- historical timeline
- AI command input
- orbit / solar system mode
- persistence

## Acceptance criteria

1. App starts without requiring a secret key.
2. A 3D Earth is visible.
3. The app fetches live public earthquake data.
4. Earthquake points render at their real coordinates.
5. Clicking a point opens normalized details.
6. Inspector shows source, observation time, coordinates, magnitude and depth.
7. Focus moves the camera to the selected entity.
8. Turning the layer off removes its rendered entities.
9. No write operation exists against any other SELECT project.

## Next increment candidates

Recommended next order:

1. satellites (TLE + SGP4)
2. aircraft
3. timeline / trails
4. traffic
5. Space mode
6. AI control
