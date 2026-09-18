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

export async function fetchStreetPhotos(latitude: number, longitude: number, signal?: AbortSignal): Promise<StreetPhoto[]> {
  const response = await fetch(`/api/street?lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`, {
    signal,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { photos?: StreetPhoto[]; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Street imagery proxy returned HTTP ${response.status}`);
  }
  return payload.photos ?? [];
}
