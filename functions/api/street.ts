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

function normalizePhotos(payload: any, lat: number, lon: number) {
  const data = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  return data.flatMap((item: any) => {
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
  }).sort((a: any, b: any) =>
    (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)
  ).slice(0, 24);
}

async function fetchKartaView(lat: number, lon: number, radius: number) {
  const api = new URL("https://api.openstreetcam.org/2.0/photo/");
  api.searchParams.set("lat", lat.toFixed(6));
  api.searchParams.set("lng", lon.toFixed(6));
  api.searchParams.set("zoomLevel", "16");
  api.searchParams.set("radius", String(radius));
  api.searchParams.set("limit", "24");
  api.searchParams.set("join", "sequence");
  api.searchParams.set("orderBy", "id");
  api.searchParams.set("orderDirection", "desc");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_500);
  try {
    const upstream = await fetch(api.toString(), {
      headers: { "User-Agent": "WorldSelect/0.5.1", Accept: "application/json" },
      signal: controller.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

    if (!upstream.ok) {
      return { ok: false as const, status: upstream.status, photos: [] as any[] };
    }
    const payload: any = await upstream.json();
    return { ok: true as const, status: 200, photos: normalizePhotos(payload, lat, lon) };
  } catch (error) {
    return {
      ok: false as const,
      status: error instanceof Error && error.name === "AbortError" ? 504 : 502,
      photos: [] as any[],
    };
  } finally {
    clearTimeout(timer);
  }
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates", photos: [] }, { status: 400 });
  }

  // KartaView's current public client uses the same /2.0/photo/ endpoint with an
  // explicit limit. Search nearby first so dense urban requests do not begin
  // with the heaviest 500 m query that previously timed out in ws-pv.
  const radii = [100, 250, 500];
  let lastFailureStatus = 0;

  for (const searchRadiusM of radii) {
    const result = await fetchKartaView(lat, lon, searchRadiusM);
    if (!result.ok) {
      lastFailureStatus = result.status;
      // A provider failure is unlikely to improve with a wider/more expensive query.
      break;
    }
    if (result.photos.length) {
      return Response.json({ photos: result.photos, searchRadiusM }, {
        headers: { "Cache-Control": "public, max-age=120, s-maxage=300" },
      });
    }
  }

  if (lastFailureStatus) {
    return Response.json({
      error: lastFailureStatus === 504 ? "KartaView upstream timed out" : `KartaView upstream HTTP ${lastFailureStatus}`,
      photos: [],
      searchRadiusM: 500,
    }, { status: 502 });
  }

  return Response.json({ photos: [], searchRadiusM: 500 }, {
    headers: { "Cache-Control": "public, max-age=60, s-maxage=120" },
  });
};
