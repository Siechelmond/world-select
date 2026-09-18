export type StreetPhoto = {
  id: string;
  imageUrl: string;
  latitude: number | null;
  longitude: number | null;
  heading: number | null;
  capturedAt: string | null;
  sequenceId: string | null;
  distanceMeters?: number | null;
};

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeKartaView(payload: any, latitude: number, longitude: number): StreetPhoto[] {
  const data = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  return data.flatMap((item: any) => {
    const imageUrl = item?.fileurlProc || item?.fileurlLTh || item?.fileurlTh || item?.fileUrl || item?.fileurl || item?.url || null;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith("http")) return [];
    const normalizedImageUrl = imageUrl.replace("[[sizeprefix]]", "wrapped_proc");
    const lat = numberOrNull(item.lat ?? item.latitude);
    const lon = numberOrNull(item.lng ?? item.lon ?? item.longitude);
    return [{
      id: String(item.id ?? item.photoId ?? normalizedImageUrl),
      imageUrl: normalizedImageUrl,
      latitude: lat,
      longitude: lon,
      heading: numberOrNull(item.heading ?? item.gpsHeading ?? item.compassAngle),
      capturedAt: item.shotDate ?? item.dateAdded ?? item.date_added ?? null,
      sequenceId: item.sequenceId != null ? String(item.sequenceId) : item.sequence?.id != null ? String(item.sequence.id) : null,
      distanceMeters: lat != null && lon != null ? Math.round(distanceMeters(latitude, longitude, lat, lon)) : null,
    }];
  }).sort((a: StreetPhoto, b: StreetPhoto) =>
    (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)
  ).slice(0, 24);
}

async function fetchKartaViewDirect(latitude: number, longitude: number, signal?: AbortSignal): Promise<StreetPhoto[]> {
  const radii = [100, 250, 500];
  for (const radius of radii) {
    const url = new URL("https://api.openstreetcam.org/2.0/photo/");
    url.searchParams.set("lat", latitude.toFixed(6));
    url.searchParams.set("lng", longitude.toFixed(6));
    url.searchParams.set("zoomLevel", "16");
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("limit", "24");
    url.searchParams.set("join", "sequence");
    url.searchParams.set("orderBy", "id");
    url.searchParams.set("orderDirection", "desc");
    const response = await fetch(url.toString(), { signal, cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`KartaView direct API returned HTTP ${response.status}`);
    const photos = normalizeKartaView(await response.json(), latitude, longitude);
    if (photos.length) return photos;
  }
  return [];
}

export async function fetchStreetPhotos(latitude: number, longitude: number, signal?: AbortSignal): Promise<StreetPhoto[]> {
  const response = await fetch(`/api/street?lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`, { signal, cache: "no-store" });
  if (response.ok) {
    const payload = (await response.json()) as { photos?: StreetPhoto[] };
    return payload.photos ?? [];
  }

  if (response.status === 502 || response.status === 504) {
    try {
      return await fetchKartaViewDirect(latitude, longitude, signal);
    } catch (directError) {
      const detail = directError instanceof Error ? directError.message : "direct KartaView API unavailable";
      throw new Error(`Street proxy HTTP ${response.status}; ${detail}`);
    }
  }

  throw new Error(`Street imagery proxy returned HTTP ${response.status}`);
}
