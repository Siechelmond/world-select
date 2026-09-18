# World Select — Architecture

## Product shape

World Select is not a collection of unrelated map widgets. It is a spatial platform with one normalized entity contract and multiple source adapters.

```text
External source
    |
    v
Adapter / validation
    |
    v
SpatialEntity[]
    |
    +---- provenance / freshness / state
    |
    v
Layer registry / client state
    |
    v
Cesium globe
    |
    +---- selection
    +---- inspector
    +---- focus / tracking
    +---- future timeline
```

## Spatial entity contract

Every map object should normalize toward:

- `id`
- `kind`
- `name`
- `position { longitude, latitude, altitudeMeters }`
- `observedAt`
- `dataState`
- `source { id, label, url? }`
- `properties`

Supported data-state vocabulary for now:

- `OBSERVED`
- `CALCULATED`
- `ESTIMATED`
- `SIMULATED`
- `STALE`
- `UNAVAILABLE`

## Layer boundary

A layer owns acquisition and normalization, not globe rendering behavior. The globe renders normalized entities without knowing the upstream provider schema.

MVP adapter:

- USGS earthquake feed -> `SpatialEntity(kind="earthquake")`

Future adapters:

- aircraft provider -> `aircraft`
- AIS provider -> `ship`
- TLE/SGP4 -> `satellite`
- ASFINAG / traffic provider -> `traffic-event`
- NASA/JPL prepared ephemerides -> `celestial-body` / `spacecraft`

## Runtime boundary

MVP v1 is browser-first and read-only. It deliberately has no database.

A server/cache layer becomes justified when a provider requires secrets, CORS shielding, normalization at scale, rate-limit protection, historical replay, or durable provenance.

## Deployment boundary

World Select must get a dedicated deployment project if/when deployed. Existing SELECT projects are out of scope.
