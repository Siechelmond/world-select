export type TrafficStatus = {
  configured: boolean;
  available: boolean;
  provider: string;
  message?: string;
  upstreamStatus?: number;
  rasterAvailable?: boolean;
  vectorAvailable?: boolean;
  rasterUpstreamStatus?: number;
  vectorUpstreamStatus?: number;
};

export async function fetchTrafficStatus(signal?: AbortSignal): Promise<TrafficStatus> {
  const response = await fetch('/api/traffic?mode=status', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Traffic proxy returned HTTP ${response.status}`);
  return response.json() as Promise<TrafficStatus>;
}
