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

const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 4_500;
const STREET_COVERAGE_TIMEOUT_MS = 3_500;

function timeoutError(label: string, timeoutMs: number) {
  return new Error(`${label} timed out after ${timeoutMs} ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (reason) => { window.clearTimeout(timer); reject(reason); },
    );
  });
}

export function loadGoogleMaps(apiKey: string): Promise<any> {
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;

  const loadPromise = new Promise<any>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
    if (existing) {
      existing.addEventListener('load', () => window.google?.maps ? resolve(window.google) : reject(new Error('Google Maps loaded without maps library')), { once: true });
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

  window.__worldSelectGoogleMapsPromise = withTimeout(loadPromise, GOOGLE_MAPS_LOAD_TIMEOUT_MS, 'Google Maps load')
    .catch((reason) => {
      window.__worldSelectGoogleMapsPromise = undefined;
      throw reason;
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
    const { data } = await withTimeout<any>(
      Promise.resolve(service.getPanorama({
        location: { lat: point.latitude, lng: point.longitude },
        radius: radiusMeters,
      })),
      STREET_COVERAGE_TIMEOUT_MS,
      'Google Street View coverage check',
    );
    const panoId = data?.location?.pano;
    const latLng = data?.location?.latLng;
    if (!panoId) return null;
    return {
      panoId,
      latitude: typeof latLng?.lat === 'function' ? latLng.lat() : point.latitude,
      longitude: typeof latLng?.lng === 'function' ? latLng.lng() : point.longitude,
    };
  } catch (reason: any) {
    const status = String(reason?.code ?? reason?.status ?? reason?.message ?? reason ?? '');
    if (status.includes('ZERO_RESULTS')) return null;
    throw reason instanceof Error ? reason : new Error('Google Street View coverage check failed');
  }
}
