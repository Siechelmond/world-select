type AuroraPayload = {
  "Observation Time"?: string;
  "Forecast Time"?: string;
  coordinates?: unknown[];
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600" },
  });
}

function latestKp(payload: unknown): number | null {
  if (!Array.isArray(payload) || !payload.length) return null;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    const row = payload[index] as Record<string, unknown>;
    const value = Number(row?.kp_index ?? row?.Kp ?? row?.kp ?? row?.estimated_kp);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export const onRequestGet = async () => {
  try {
    const [auroraResponse, kpResponse] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
        headers: { Accept: "application/json", "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)" },
        cf: { cacheTtl: 180, cacheEverything: true },
      } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } }),
      fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
        headers: { Accept: "application/json", "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)" },
        cf: { cacheTtl: 180, cacheEverything: true },
      } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } }),
    ]);
    if (!auroraResponse.ok) return json({ error: `NOAA SWPC aurora returned HTTP ${auroraResponse.status}`, items: [] }, 502);
    const aurora = await auroraResponse.json() as AuroraPayload;
    const kpPayload = kpResponse.ok ? await kpResponse.json() : null;
    const kp = latestKp(kpPayload);
    const observedAt = aurora["Forecast Time"] ?? aurora["Observation Time"] ?? new Date().toISOString();
    const candidates = (Array.isArray(aurora.coordinates) ? aurora.coordinates : [])
      .flatMap((row) => {
        if (!Array.isArray(row) || row.length < 3) return [];
        const lon = Number(row[0]);
        const lat = Number(row[1]);
        const probability = Number(row[2]);
        if (![lon, lat, probability].every(Number.isFinite) || probability < 8) return [];
        return [{ lon, lat, probability }];
      })
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 1400);

    const items = candidates.map((row) => ({
      id: `swpc:aurora:${row.lon.toFixed(1)}:${row.lat.toFixed(1)}`,
      kind: "aurora",
      name: `Aurora ${Math.round(row.probability)}%`,
      position: { longitude: row.lon, latitude: row.lat, altitudeMeters: 110_000 },
      observedAt,
      dataState: "OBSERVED",
      source: {
        id: "noaa-swpc-ovation",
        label: "NOAA SWPC OVATION",
        url: "https://www.swpc.noaa.gov/products/aurora-30-minute-forecast",
      },
      properties: { probability: row.probability, kp },
    }));
    return json({
      items,
      kp,
      observationTime: aurora["Observation Time"] ?? null,
      forecastTime: aurora["Forecast Time"] ?? null,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "NOAA SWPC unavailable", items: [] }, 502);
  }
};
