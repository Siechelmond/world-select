import type { SpatialEntity } from "@/lib/spatial";

const USGS_FEED =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";

type UsgsFeature = {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url: string | null;
    status?: string | null;
    type?: string | null;
  };
  geometry: {
    coordinates: [number, number, number];
  };
};

type UsgsFeed = {
  features: UsgsFeature[];
};

export async function fetchEarthquakes(signal?: AbortSignal): Promise<SpatialEntity[]> {
  const response = await fetch(USGS_FEED, {
    signal,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`USGS feed returned HTTP ${response.status}`);
  }

  const feed = (await response.json()) as UsgsFeed;

  return feed.features.map((feature) => {
    const [longitude, latitude, depthKm] = feature.geometry.coordinates;
    const magnitude = feature.properties.mag;
    const place = feature.properties.place ?? "Unspecified location";

    return {
      id: `usgs:${feature.id}`,
      kind: "earthquake",
      name: `${magnitude?.toFixed(1) ?? "?"} · ${place}`,
      position: {
        longitude,
        latitude,
        altitudeMeters: 0,
      },
      observedAt: new Date(feature.properties.time).toISOString(),
      dataState: "OBSERVED",
      source: {
        id: "usgs-earthquakes",
        label: "USGS Earthquake Hazards Program",
        url: feature.properties.url ?? undefined,
      },
      properties: {
        magnitude,
        place,
        depthKm,
        status: feature.properties.status ?? null,
        eventType: feature.properties.type ?? "earthquake",
      },
    } satisfies SpatialEntity;
  });
}
