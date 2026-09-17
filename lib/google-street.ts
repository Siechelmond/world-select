export type GoogleStreetCoverage = {
  panoId: string;
  latitude: number;
  longitude: number;
};

declare global {
  interface Window {
    google?: any;
    __worldSelectGoogleMapsPromise?: Promise<any>;
  }
}

export function loadGoogleMaps(apiKey: string): Promise<any> {
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;

  window.__worldSelectGoogleMapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Maps JavaScript API could not be loaded')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async`;
    script.async = true;
    script.defer = true;
    script.dataset.worldSelectGoogleMaps = '1';
    script.onload = () => window.google?.maps ? resolve(window.google) : reject(new Error('Google Maps loaded without maps library'));
    script.onerror = () => reject(new Error('Google Maps JavaScript API could not be loaded'));
    document.head.appendChild(script);
  });

  return window.__worldSelectGoogleMapsPromise;
}

export async function findGoogleStreetCoverage(
  apiKey: string,
  point: { latitude: number; longitude: number },
  radiusMeters = 120,
): Promise<GoogleStreetCoverage | null> {
  if (!apiKey) return null;
  const google = await loadGoogleMaps(apiKey);
  const service = new google.maps.StreetViewService();
  try {
    const { data } = await service.getPanorama({
      location: { lat: point.latitude, lng: point.longitude },
      radius: radiusMeters,
    });
    const panoId = data?.location?.pano;
    const latLng = data?.location?.latLng;
    if (!panoId) return null;
    return {
      panoId,
      latitude: typeof latLng?.lat === 'function' ? latLng.lat() : point.latitude,
      longitude: typeof latLng?.lng === 'function' ? latLng.lng() : point.longitude,
    };
  } catch {
    return null;
  }
}
