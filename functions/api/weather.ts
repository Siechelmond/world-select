function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600" },
  });
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: "invalid coordinates", items: [] }, 400);
  }
  const upstream = new URL("https://api.open-meteo.com/v1/forecast");
  upstream.searchParams.set("latitude", String(lat));
  upstream.searchParams.set("longitude", String(lon));
  upstream.searchParams.set(
    "current",
    "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,visibility",
  );
  upstream.searchParams.set("timezone", "UTC");

  try {
    const response = await fetch(upstream.toString(), {
      headers: { Accept: "application/json", "User-Agent": "WorldSelect/0.6 (+https://world-select.pages.dev)" },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!response.ok) return json({ error: `Open-Meteo returned HTTP ${response.status}`, items: [] }, 502);
    const payload = await response.json() as {
      current?: Record<string, string | number>;
      current_units?: Record<string, string>;
    };
    const current = payload.current ?? {};
    const observedAt = typeof current.time === "string" && !Number.isNaN(Date.parse(current.time))
      ? new Date(current.time).toISOString()
      : new Date().toISOString();
    const item = {
      id: `weather:${lat.toFixed(3)}:${lon.toFixed(3)}`,
      kind: "weather-observation",
      name: `${Number(current.temperature_2m ?? 0).toFixed(1)}°C · Weather`,
      position: { longitude: lon, latitude: lat, altitudeMeters: 80 },
      observedAt,
      dataState: "OBSERVED",
      source: { id: "open-meteo", label: "Open-Meteo", url: "https://open-meteo.com/" },
      properties: {
        temperatureC: Number(current.temperature_2m ?? 0),
        weatherCode: Number(current.weather_code ?? 0),
        windKmh: Number(current.wind_speed_10m ?? 0),
        windDirectionDeg: Number(current.wind_direction_10m ?? 0),
        precipitationMm: Number(current.precipitation ?? 0),
        cloudCoverPct: Number(current.cloud_cover ?? 0),
        visibilityM: Number(current.visibility ?? 0),
      },
    };
    return json({ items: [item] });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Open-Meteo unavailable", items: [] }, 502);
  }
};
