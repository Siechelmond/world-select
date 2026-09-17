export type StreetPhoto = {
  id: string;
  imageUrl: string;
  latitude: number | null;
  longitude: number | null;
  heading: number | null;
  capturedAt: string | null;
  sequenceId: string | null;
  distanceMeters?: number | null;
};

const STREET_PROXY_TIMEOUT_MS = 5_000;

export async function fetchStreetPhotos(latitude: number, longitude: number, signal?: AbortSignal): Promise<StreetPhoto[]> {
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort('street proxy timeout'), STREET_PROXY_TIMEOUT_MS);
  const onAbort = () => timeoutController.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) timeoutController.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(`/api/street?lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`, {
      signal: timeoutController.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Street imagery proxy returned HTTP ${response.status}`);
    const payload = (await response.json()) as { photos?: StreetPhoto[]; searchRadiusM?: number };
    return payload.photos ?? [];
  } catch (reason) {
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new Error(`Street imagery proxy timed out after ${STREET_PROXY_TIMEOUT_MS} ms`);
    }
    throw reason;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}
