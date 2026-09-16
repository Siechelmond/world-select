export type StreetPhoto = {
  id: string;
  imageUrl: string;
  latitude: number | null;
  longitude: number | null;
  heading: number | null;
  capturedAt: string | null;
  sequenceId: string | null;
};

export async function fetchStreetPhotos(latitude: number, longitude: number, signal?: AbortSignal): Promise<StreetPhoto[]> {
  const response = await fetch(`/api/street?lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Street imagery proxy returned HTTP ${response.status}`);
  const payload = (await response.json()) as { photos?: StreetPhoto[] };
  return payload.photos ?? [];
}
