export type SpaceLaunch = {
  id: string;
  name: string;
  net: string | null;
  status: string | null;
  provider: string | null;
  pad: string | null;
  location: string | null;
};

export async function fetchRecentLaunches(signal?: AbortSignal): Promise<SpaceLaunch[]> {
  const response = await fetch('/api/launches', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Launch Library proxy returned HTTP ${response.status}`);
  const payload = await response.json() as { results?: SpaceLaunch[] };
  return Array.isArray(payload.results) ? payload.results : [];
}
