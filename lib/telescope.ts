export type TelescopeFilter = "all" | "jwst" | "hubble" | "observatory";

export type TelescopeImage = {
  id: string;
  nasaId: string;
  title: string;
  description: string;
  dateCreated: string | null;
  mission: string;
  instrument: string | null;
  center: string | null;
  credit: string;
  thumbnailUrl: string;
  sourceUrl: string;
};

export type TelescopeFeed = {
  items: TelescopeImage[];
  source: string;
  dataAsOf: string;
  degraded?: boolean;
};

export async function fetchTelescopeImages(
  filter: TelescopeFilter,
  query: string,
  signal?: AbortSignal,
): Promise<TelescopeFeed> {
  const params = new URLSearchParams({ source: filter });
  const cleanQuery = query.trim();
  if (cleanQuery) params.set("q", cleanQuery);

  const response = await fetch(`/api/telescope?${params.toString()}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Telescope image proxy returned HTTP ${response.status}`);
  }

  const payload = await response.json() as Partial<TelescopeFeed>;
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    source: payload.source ?? "NASA Image and Video Library",
    dataAsOf: payload.dataAsOf ?? new Date().toISOString(),
    degraded: Boolean(payload.degraded),
  };
}

export async function fetchTelescopeAsset(
  nasaId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const params = new URLSearchParams({ asset: nasaId });
  const response = await fetch(`/api/telescope?${params.toString()}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = await response.json() as { imageUrl?: unknown };
  return typeof payload.imageUrl === "string" && payload.imageUrl.startsWith("http")
    ? payload.imageUrl
    : null;
}
