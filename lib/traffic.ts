export type TrafficStatus = {
  configured: boolean;
  provider: string;
  message?: string;
};

export async function fetchTrafficStatus(signal?: AbortSignal): Promise<TrafficStatus> {
  const response = await fetch('/api/traffic?mode=status', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Traffic proxy returned HTTP ${response.status}`);
  return response.json() as Promise<TrafficStatus>;
}
