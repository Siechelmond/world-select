export type RouteProfile = 'foot' | 'car' | 'bike';
export type RoutePoint = { latitude: number; longitude: number };
export type RouteResult = {
  ok: true;
  profile: RouteProfile;
  distanceM: number;
  durationS: number;
  coordinates: Array<[number, number]>;
  provider: string;
  coverage: string;
};

export async function fetchRoute(
  a: RoutePoint,
  b: RoutePoint,
  profile: RouteProfile,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const coords = `${a.longitude.toFixed(6)},${a.latitude.toFixed(6)};${b.longitude.toFixed(6)},${b.latitude.toFixed(6)}`;
  const response = await fetch(`/api/route?profile=${encodeURIComponent(profile)}&coords=${encodeURIComponent(coords)}`, {
    signal,
    cache: 'no-store',
  });
  let payload: any = null;
  try { payload = await response.json(); } catch { /* non-json upstream */ }
  if (!response.ok || !payload?.ok || !Array.isArray(payload.coordinates)) {
    throw new Error(payload?.error || `Route proxy returned HTTP ${response.status}`);
  }
  return payload as RouteResult;
}

export function formatDistance(meters: number) {
  if (!Number.isFinite(meters)) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km` : `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
