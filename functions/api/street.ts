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

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates", photos: [] }, { status: 400 });
  }

  // KartaView documents radius as 1..500 m. Older World Select builds asked for 1500 m,
  // which was outside the documented contract and could return no usable imagery.
  const searchRadiusM = 500;
  const api = new URL("https://api.openstreetcam.org/2.0/photo/");
  api.searchParams.set("lat", lat.toFixed(6));
  api.searchParams.set("lng", lon.toFixed(6));
  api.searchParams.set("zoomLevel", "16");
  api.searchParams.set("radius", String(searchRadiusM));
  api.searchParams.set("join", "sequence");
  api.searchParams.set("orderBy", "id");
  api.searchParams.set("orderDirection", "desc");

  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort('KartaView upstream timeout'), 4_000);
  let upstream: Response;
  try {
    upstream = await fetch(api.toString(), {
      headers: { "User-Agent": "WorldSelect/0.7", Accept: "application/json" },
      signal: upstreamController.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  } catch {
    const timedOut = upstreamController.signal.aborted;
    return Response.json({
      error: timedOut ? "KartaView upstream timeout" : "KartaView upstream request failed",
      photos: [],
      searchRadiusM,
    }, { status: 504 });
  } finally {
    clearTimeout(upstreamTimeout);
  }

  if (!upstream.ok) {
    return Response.json({ error: `KartaView upstream HTTP ${upstream.status}`, photos: [], searchRadiusM }, { status: 502 });
  }

  const payload: any = await upstream.json();
  const data = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const photos = data.flatMap((item: any) => {
    const imageUrl = item?.fileurlProc || item?.fileurlLTh || item?.fileurlTh || item?.fileUrl || item?.fileurl || item?.url || null;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith("http")) return [];
    const normalizedImageUrl = imageUrl.replace("[[sizeprefix]]", "wrapped_proc");
    const latitude = numberOrNull(item.lat ?? item.latitude);
    const longitude = numberOrNull(item.lng ?? item.lon ?? item.longitude);
    return [{
      id: String(item.id ?? item.photoId ?? normalizedImageUrl),
      imageUrl: normalizedImageUrl,
      latitude,
      longitude,
      heading: numberOrNull(item.heading ?? item.gpsHeading ?? item.compassAngle),
      capturedAt: item.dateAdded ?? item.date_added ?? null,
      sequenceId: item.sequenceId != null ? String(item.sequenceId) : item.sequence?.id != null ? String(item.sequence.id) : null,
      distanceMeters: latitude != null && longitude != null ? Math.round(distanceMeters(lat, lon, latitude, longitude)) : null,
    }];
  }).sort((a: any, b: any) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)).slice(0, 24);

  return Response.json({ photos, searchRadiusM }, {
    headers: { "Cache-Control": "public, max-age=120, s-maxage=300" },
  });
};
