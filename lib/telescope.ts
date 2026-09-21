export type TelescopeFilter =
  | "all"
  | "jwst"
  | "hubble"
  | "other"
  | "solar-system"
  | "galaxies"
  | "nebulae"
  | "stars-clusters";

export type TelescopeProviderId = "nasa-images" | "esa-webb" | "hubble-science";
export type TelescopeSubject = "solar-system" | "galaxies" | "nebulae" | "stars-clusters" | "other";

export type TelescopeImage = {
  id: string;
  sourceId: string;
  providerId: TelescopeProviderId;
  provider: string;
  title: string;
  description: string;
  dateCreated: string | null;
  telescope: string;
  instrument: string | null;
  subject: TelescopeSubject;
  sourceOrganizations: string[];
  credit: string;
  thumbnailUrl: string;
  highResUrl: string | null;
  sourceUrl: string;
  rights: string | null;
  observationType: string | null;
};

export type TelescopeFeed = {
  items: TelescopeImage[];
  sources: string[];
  dataAsOf: string;
  degraded?: boolean;
  semantics?: string;
};

export async function fetchTelescopeImages(
  filter: TelescopeFilter,
  query: string,
  signal?: AbortSignal,
): Promise<TelescopeFeed> {
  const params = new URLSearchParams({ source: filter });
  const cleanQuery = query.trim();
  if (cleanQuery) params.set("q", cleanQuery);

  const response = await fetch("/api/telescope?" + params.toString(), {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Telescope observation proxy returned HTTP " + response.status);
  }

  const payload = await response.json() as Partial<TelescopeFeed>;
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    dataAsOf: payload.dataAsOf ?? new Date().toISOString(),
    degraded: Boolean(payload.degraded),
    semantics: payload.semantics,
  };
}

export async function fetchTelescopeAsset(
  item: TelescopeImage,
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof item.highResUrl === "string" && item.highResUrl.startsWith("http")) {
    return item.highResUrl;
  }
  if (item.providerId !== "nasa-images") return null;

  const params = new URLSearchParams({
    asset: item.sourceId,
    provider: item.providerId,
  });
  const response = await fetch("/api/telescope?" + params.toString(), {
    signal,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = await response.json() as { imageUrl?: unknown };
  return typeof payload.imageUrl === "string" && payload.imageUrl.startsWith("http")
    ? payload.imageUrl
    : null;
}
