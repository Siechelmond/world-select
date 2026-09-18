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
    const imageUrl = item?.imageProcUrl || item?.imageLThUrl || item?.fileurlProc || item?.fileurlLTh || item?.fileurlTh || item?.fileUrl || item?.fileurl || item?.url || null;
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

async function requestKartaView(url: URL, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "WorldSelect/0.7 (+https://world-select.pages.dev)",
      },
      signal: controller.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

    const payload = await upstream.json().catch(() => null) as any;
    const apiHttpCode = Number(payload?.status?.httpCode);
    const apiCode = Number(payload?.status?.apiCode);
    const logicalFailure =
      (Number.isFinite(apiHttpCode) && apiHttpCode >= 400) ||
      (Number.isFinite(apiCode) && apiCode >= 610);

    if (!upstream.ok || logicalFailure) {
      return {
        ok: false as const,
        status: Number.isFinite(apiHttpCode) && apiHttpCode >= 400 ? apiHttpCode : upstream.status,
        payload,
      };
    }

    return { ok: true as const, status: upstream.status, payload };
  } catch (error) {
    return {
      ok: false as const,
      status: error instanceof Error && error.name === "AbortError" ? 504 : 502,
      payload: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKartaView(lat: number, lon: number) {
  const buildNearbyUrl = (zoomLevel: number) => {
    const endpoint = new URL("https://api.openstreetcam.org/2.0/photo/");
    endpoint.searchParams.set("lat", lat.toFixed(6));
    endpoint.searchParams.set("lng", lon.toFixed(6));
    endpoint.searchParams.set("zoomLevel", String(zoomLevel));
    endpoint.searchParams.set("join", "sequence");
    endpoint.searchParams.set("orderBy", "id");
    endpoint.searchParams.set("orderDirection", "desc");
    return endpoint;
  };

  // KartaView documents lat/lng/zoomLevel for nearby-photo lookup.
  // Keep this contract clean: page/itemsPerPage belong to sequence paging.
  const primary = await requestKartaView(buildNearbyUrl(18));
  if (primary.ok) {
    const photos = normalizePhotos(primary.payload, lat, lon);
    if (photos.length) return { ok: true as const, status: 200, photos, mode: "nearby-z18" };
  }

  const wider = await requestKartaView(buildNearbyUrl(16));
  if (wider.ok) {
    const photos = normalizePhotos(wider.payload, lat, lon);
    if (photos.length) return { ok: true as const, status: 200, photos, mode: "nearby-z16" };
  }

  // KartaView FAQ documents radius search as a public nearby fallback.
  const radiusEndpoint = new URL("https://api.openstreetcam.org/2.0/photo/");
  radiusEndpoint.searchParams.set("lat", lat.toFixed(6));
  radiusEndpoint.searchParams.set("lng", lon.toFixed(6));
  radiusEndpoint.searchParams.set("radius", "500");
  const radius = await requestKartaView(radiusEndpoint);
  if (radius.ok) {
    return {
      ok: true as const,
      status: 200,
      photos: normalizePhotos(radius.payload, lat, lon),
      mode: "radius-500",
    };
  }

  const failures = [primary, wider, radius].filter((item) => !item.ok);
  const timeoutOnly = failures.length > 0 && failures.every((item) => item.status === 504);
  return {
    ok: false as const,
    status: timeoutOnly ? 504 : 502,
    photos: [] as any[],
    mode: "unavailable",
  };
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates", photos: [] }, { status: 400 });
  }

  const result = await fetchKartaView(lat, lon);
  if (!result.ok) {
    return Response.json({
      error: result.status === 504 ? "KartaView upstream timed out" : `KartaView upstream HTTP ${result.status}`,
      photos: [],
    }, { status: 502 });
  }

  return Response.json({ photos: result.photos, sourceMode: result.mode }, {
    headers: {
      "Cache-Control": result.photos.length
        ? "public, max-age=120, s-maxage=300"
        : "public, max-age=60, s-maxage=120",
    },
  });
};
