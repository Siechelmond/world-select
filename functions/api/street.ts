function numberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates", photos: [] }, { status: 400 });
  }
  const api = new URL("https://api.openstreetcam.org/2.0/photo/");
  api.searchParams.set("lat", lat.toFixed(6));
  api.searchParams.set("lng", lon.toFixed(6));
  api.searchParams.set("zoomLevel", "18");
  api.searchParams.set("join", "sequence");
  api.searchParams.set("orderBy", "id");
  api.searchParams.set("orderDirection", "desc");

  const upstream = await fetch(api.toString(), {
    headers: { "User-Agent": "WorldSelect/0.3.1" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!upstream.ok) return Response.json({ error: `KartaView upstream HTTP ${upstream.status}`, photos: [] }, { status: 502 });
  const payload: any = await upstream.json();
  const data = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const photos = data.slice(0, 24).flatMap((item: any) => {
    const imageUrl = item?.fileUrl || item?.fileurl || item?.url || null;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith("http")) return [];
    return [{
      id: String(item.id ?? item.photoId ?? imageUrl),
      imageUrl,
      latitude: numberOrNull(item.lat ?? item.latitude),
      longitude: numberOrNull(item.lng ?? item.lon ?? item.longitude),
      heading: numberOrNull(item.heading ?? item.gpsHeading ?? item.compassAngle),
      capturedAt: item.dateAdded ?? item.date_added ?? null,
      sequenceId: item.sequenceId != null ? String(item.sequenceId) : item.sequence?.id != null ? String(item.sequence.id) : null,
    }];
  });
  return Response.json({ photos }, { headers: { "Cache-Control": "public, max-age=120, s-maxage=300" } });
};
