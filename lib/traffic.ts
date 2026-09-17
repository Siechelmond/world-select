export type TrafficStatus = {
  configured: boolean;
  available: boolean;
  provider: string;
  message?: string;
  upstreamStatus?: number;
};

const TRAFFIC_STATUS_TIMEOUT_MS = 6_500;

export async function fetchTrafficStatus(signal?: AbortSignal): Promise<TrafficStatus> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort('traffic status timeout'), TRAFFIC_STATUS_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch('/api/traffic?mode=status', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Traffic proxy returned HTTP ${response.status}`);
    return response.json() as Promise<TrafficStatus>;
  } catch (reason) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error(`Traffic status timed out after ${TRAFFIC_STATUS_TIMEOUT_MS} ms`);
    throw reason;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
