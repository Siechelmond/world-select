import type { SpatialEntity } from "@/lib/spatial";

export type InfrastructureCategory = "cable" | "landing" | "datacenter" | "dam";
export type InfrastructureFeature = {
  id: string;
  category: InfrastructureCategory;
  name: string;
  operator?: string;
  point?: { longitude: number; latitude: number };
  coordinates?: Array<[number, number]>;
};

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`${url.split("?")[0]} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function fetchNaturalEvents(signal?: AbortSignal): Promise<SpatialEntity[]> {
  const payload = await getJson<{ items?: SpatialEntity[] }>("/api/events", signal);
  return payload.items ?? [];
}

export async function fetchAurora(signal?: AbortSignal): Promise<{ items: SpatialEntity[]; kp: number | null }> {
  const payload = await getJson<{ items?: SpatialEntity[]; kp?: number | null }>("/api/space-weather", signal);
  return { items: payload.items ?? [], kp: Number.isFinite(payload.kp) ? Number(payload.kp) : null };
}

export async function fetchWeather(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<SpatialEntity[]> {
  const payload = await getJson<{ items?: SpatialEntity[] }>(
    `/api/weather?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
    signal,
  );
  return payload.items ?? [];
}

export async function fetchRadioStations(signal?: AbortSignal): Promise<SpatialEntity[]> {
  const payload = await getJson<{ items?: SpatialEntity[] }>("/api/radio", signal);
  return payload.items ?? [];
}

export async function fetchInfrastructure(
  latitude: number,
  longitude: number,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<InfrastructureFeature[]> {
  const payload = await getJson<{ features?: InfrastructureFeature[] }>(
    `/api/infrastructure?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}&radius=${Math.round(radiusKm)}`,
    signal,
  );
  return payload.features ?? [];
}


export type PlaceSearchResult = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  kind: string;
  heightMeters: number;
};

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSearchResult[]> {
  const payload = await getJson<{ results?: PlaceSearchResult[] }>(
    `/api/geocode?q=${encodeURIComponent(query.trim())}`,
    signal,
  );
  return payload.results ?? [];
}
