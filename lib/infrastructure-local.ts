import type { InfrastructureFeature } from '@/lib/keyless';

type GeoJsonFeature = {
  id?: string | number;
  type?: 'Feature';
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
};

type GeoJsonCollection = {
  type?: 'FeatureCollection';
  features?: GeoJsonFeature[];
};

export type InfrastructureBaseline = {
  features: InfrastructureFeature[];
  errors: string[];
  loadedAt: number;
};

const ROOT = '/data/infrastructure';
const DATASETS = Object.freeze({
  datacenters: `${ROOT}/datacenters.geojsonl`,
  dams: `${ROOT}/dams.geojsonl`,
  cables: `${ROOT}/cable-geo.json`,
  landing: `${ROOT}/landing-point-geo.json`,
});

let cachedBaseline: InfrastructureBaseline | null = null;
let baselinePromise: Promise<InfrastructureBaseline> | null = null;

function finiteLonLat(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function collectLonLat(value: unknown, out: Array<[number, number]>) {
  if (!Array.isArray(value)) return;
  const direct = finiteLonLat(value);
  if (direct) {
    out.push(direct);
    return;
  }
  for (const child of value) collectLonLat(child, out);
}

// Ported from ws-donor/src/layers/submarineCables/geometry.js: prefer an
// explicit representative coordinate, then Point geometry, then a bounded
// centroid over geometry vertices. This lets the existing WS inspector keep a
// single representative position without camera-dependent acquisition.
function featureReference(feature: GeoJsonFeature): [number, number] | null {
  const props = feature.properties ?? {};
  const propertyCoords = finiteLonLat(props.coordinates);
  if (propertyCoords) return propertyCoords;
  if (feature.geometry?.type === 'Point') {
    return finiteLonLat(feature.geometry.coordinates);
  }
  const coords: Array<[number, number]> = [];
  collectLonLat(feature.geometry?.coordinates, coords);
  if (!coords.length) return null;
  let lon = 0;
  let lat = 0;
  for (const point of coords) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / coords.length, lat / coords.length];
}

function featureLabel(feature: GeoJsonFeature, fallback: string) {
  const props = feature.properties ?? {};
  const tags = props.tags && typeof props.tags === 'object'
    ? props.tags as Record<string, unknown>
    : {};
  return String(props.name ?? tags.name ?? props.id ?? feature.id ?? fallback).trim() || fallback;
}

function featureOperator(feature: GeoJsonFeature) {
  const props = feature.properties ?? {};
  const tags = props.tags && typeof props.tags === 'object'
    ? props.tags as Record<string, unknown>
    : {};
  const value = props.operator ?? tags.operator;
  return value == null ? undefined : String(value);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url: string): Promise<GeoJsonCollection> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json() as Promise<GeoJsonCollection>;
}

function parseGeoJsonLines(text: string): GeoJsonFeature[] {
  const out: GeoJsonFeature[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as GeoJsonFeature);
  }
  return out;
}

function normalizePointDataset(
  features: GeoJsonFeature[],
  category: 'datacenter' | 'dam',
): InfrastructureFeature[] {
  const out: InfrastructureFeature[] = [];
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const point = featureReference(feature);
    if (!point) continue;
    const rawId = feature.id ?? feature.properties?.osm_id ?? index;
    out.push({
      id: `donor:${category}:${String(rawId)}`,
      category,
      name: featureLabel(feature, category === 'dam' ? 'Dam' : 'Datacenter'),
      operator: featureOperator(feature),
      point: { longitude: point[0], latitude: point[1] },
      source: {
        id: category === 'dam' ? 'ws-donor-dams' : 'ws-donor-datacenters',
        label: category === 'dam' ? 'ws-donor bundled dams' : 'ws-donor bundled datacenters',
        url: 'https://www.openstreetmap.org/',
      },
    });
  }
  return out;
}

function normalizeCableDataset(collection: GeoJsonCollection): InfrastructureFeature[] {
  const out: InfrastructureFeature[] = [];
  const features = Array.isArray(collection.features) ? collection.features : [];
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const props = feature.properties ?? {};
    const rawId = String(props.id ?? feature.id ?? `cable-${index}`);
    const name = featureLabel(feature, 'Submarine cable');
    const geometry = feature.geometry;
    const lines = geometry?.type === 'MultiLineString'
      ? (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
      : geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : [];
    let part = 0;
    for (const rawLine of lines) {
      const coordinates: Array<[number, number]> = [];
      if (Array.isArray(rawLine)) {
        for (const rawPoint of rawLine) {
          const point = finiteLonLat(rawPoint);
          if (point) coordinates.push(point);
        }
      }
      if (coordinates.length < 2) continue;
      out.push({
        id: `donor:cable:${rawId}:${part++}`,
        category: 'cable',
        name,
        coordinates,
        source: {
          id: 'telegeography-submarine-cables',
          label: 'TeleGeography bundled via ws-donor',
          url: 'https://www.submarinecablemap.com/',
        },
      });
    }
  }
  return out;
}

function normalizeLandingDataset(collection: GeoJsonCollection): InfrastructureFeature[] {
  const out: InfrastructureFeature[] = [];
  const features = Array.isArray(collection.features) ? collection.features : [];
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const point = featureReference(feature);
    if (!point) continue;
    const props = feature.properties ?? {};
    const rawId = String(props.id ?? feature.id ?? index);
    out.push({
      id: `donor:landing:${rawId}`,
      category: 'landing',
      name: featureLabel(feature, 'Cable landing point'),
      point: { longitude: point[0], latitude: point[1] },
      source: {
        id: 'telegeography-submarine-cables',
        label: 'TeleGeography bundled via ws-donor',
        url: 'https://www.submarinecablemap.com/',
      },
    });
  }
  return out;
}

async function loadBaseline(): Promise<InfrastructureBaseline> {
  const errors: string[] = [];
  const features: InfrastructureFeature[] = [];
  const settled = await Promise.allSettled([
    fetchText(DATASETS.datacenters).then(parseGeoJsonLines).then((items) => normalizePointDataset(items, 'datacenter')),
    fetchText(DATASETS.dams).then(parseGeoJsonLines).then((items) => normalizePointDataset(items, 'dam')),
    fetchJson(DATASETS.cables).then(normalizeCableDataset),
    fetchJson(DATASETS.landing).then(normalizeLandingDataset),
  ]);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      features.push(...result.value);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  if (!features.length) {
    throw new Error(errors[0] ?? 'Bundled infrastructure baseline unavailable');
  }
  return { features, errors, loadedAt: Date.now() };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function loadInfrastructureBaseline(signal?: AbortSignal): Promise<InfrastructureBaseline> {
  if (cachedBaseline) return withAbort(Promise.resolve(cachedBaseline), signal);
  if (!baselinePromise) {
    baselinePromise = loadBaseline()
      .then((baseline) => {
        cachedBaseline = baseline;
        return baseline;
      })
      .catch((error) => {
        baselinePromise = null;
        throw error;
      });
  }
  return withAbort(baselinePromise, signal);
}
