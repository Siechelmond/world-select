export type GoogleStreetCoverage = {
  panoId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

declare global {
  interface Window {
    google?: any;
    __worldSelectGoogleMapsPromise?: Promise<any>;
    gm_authFailure?: () => void;
  }
}

const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 6_000;
const STREET_COVERAGE_TIMEOUT_MS = 4_500;
const STREET_SEARCH_RADII_M = [120, 250, 500];

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

async function ensureStreetViewLibrary(google: any): Promise<any> {
  if (!google?.maps) throw new Error('Google Maps loaded without maps library');

  if (typeof google.maps.StreetViewService === 'function' && typeof google.maps.StreetViewPanorama === 'function') {
    return google;
  }

  if (typeof google.maps.importLibrary === 'function') {
    const streetView = await google.maps.importLibrary('streetView');
    if (typeof google.maps.StreetViewService !== 'function' && typeof streetView?.StreetViewService === 'function') {
      google.maps.StreetViewService = streetView.StreetViewService;
    }
    if (typeof google.maps.StreetViewPanorama !== 'function' && typeof streetView?.StreetViewPanorama === 'function') {
      google.maps.StreetViewPanorama = streetView.StreetViewPanorama;
    }
    if (!google.maps.StreetViewStatus && streetView?.StreetViewStatus) google.maps.StreetViewStatus = streetView.StreetViewStatus;
    if (!google.maps.StreetViewSource && streetView?.StreetViewSource) google.maps.StreetViewSource = streetView.StreetViewSource;
    if (!google.maps.StreetViewPreference && streetView?.StreetViewPreference) google.maps.StreetViewPreference = streetView.StreetViewPreference;
  }

  if (typeof google.maps.StreetViewService !== 'function' || typeof google.maps.StreetViewPanorama !== 'function') {
    throw new Error('Google Street View library is unavailable');
  }

  return google;
}

export function loadGoogleMaps(apiKey: string): Promise<any> {
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;

  const loadPromise = window.google?.maps
    ? Promise.resolve(window.google)
    : new Promise<any>((resolve, reject) => {
        const previousAuthFailure = window.gm_authFailure;
        window.gm_authFailure = () => {
          previousAuthFailure?.();
          reject(new Error('Google Maps authentication/referrer check failed'));
        };

        const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
        if (existing) {
          existing.addEventListener('load', () => window.google?.maps ? resolve(window.google) : reject(new Error('Google Maps loaded without maps library')), { once: true });
          existing.addEventListener('error', () => reject(new Error('Google Maps JavaScript API could not be loaded')), { once: true });
          return;
        }

        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&libraries=streetView`;
        script.async = true;
        script.defer = true;
        script.dataset.worldSelectGoogleMaps = '1';
        script.onload = () => window.google?.maps ? resolve(window.google) : reject(new Error('Google Maps loaded without maps library'));
        script.onerror = () => reject(new Error('Google Maps JavaScript API could not be loaded'));
        document.head.appendChild(script);
      });

  window.__worldSelectGoogleMapsPromise = withTimeout(
    loadPromise.then((google) => ensureStreetViewLibrary(google)),
    GOOGLE_MAPS_LOAD_TIMEOUT_MS,
    'Google Maps + Street View load',
  ).catch((reason) => {
    window.__worldSelectGoogleMapsPromise = undefined;
    throw reason;
  });

  return window.__worldSelectGoogleMapsPromise;
}

function requestStreetPanorama(
  google: any,
  service: any,
  point: { latitude: number; longitude: number },
  radiusMeters: number,
): Promise<GoogleStreetCoverage | null> {
  return withTimeout(new Promise<GoogleStreetCoverage | null>((resolve, reject) => {
    const request: Record<string, unknown> = {
      location: { lat: point.latitude, lng: point.longitude },
      radius: radiusMeters,
    };
    if (google.maps.StreetViewPreference?.NEAREST) request.preference = google.maps.StreetViewPreference.NEAREST;
    if (google.maps.StreetViewSource?.OUTDOOR) request.source = google.maps.StreetViewSource.OUTDOOR;

    service.getPanorama(request, (data: any, status: any) => {
      const ok = status === google.maps.StreetViewStatus?.OK || String(status) === 'OK';
      const zero = status === google.maps.StreetViewStatus?.ZERO_RESULTS || String(status) === 'ZERO_RESULTS';
      if (zero) {
        resolve(null);
        return;
      }
      if (!ok) {
        reject(new Error(`Google Street View coverage check failed (${String(status || 'UNKNOWN_STATUS')})`));
        return;
      }
      const panoId = data?.location?.pano;
      const latLng = data?.location?.latLng;
      if (!panoId) {
        resolve(null);
        return;
      }
      resolve({
        panoId,
        latitude: typeof latLng?.lat === 'function' ? latLng.lat() : point.latitude,
        longitude: typeof latLng?.lng === 'function' ? latLng.lng() : point.longitude,
        radiusMeters,
      });
    });
  }), STREET_COVERAGE_TIMEOUT_MS, `Google Street View ${radiusMeters} m coverage check`);
}

export async function findGoogleStreetCoverage(
  apiKey: string,
  point: { latitude: number; longitude: number },
  radiusMeters = 120,
): Promise<GoogleStreetCoverage | null> {
  if (!apiKey) return null;
  const google = await loadGoogleMaps(apiKey);
  const service = new google.maps.StreetViewService();
  const radii = Array.from(new Set([radiusMeters, ...STREET_SEARCH_RADII_M])).filter((radius) => radius > 0 && radius <= 500);

  let lastError: Error | null = null;
  for (const radius of radii) {
    try {
      const result = await requestStreetPanorama(google, service, point, radius);
      if (result) return result;
    } catch (reason) {
      lastError = reason instanceof Error ? reason : new Error('Google Street View coverage check failed');
      // Authentication, quota and request-denied errors will not improve with a
      // wider radius. Fail fast so KartaView can take over immediately.
      if (/auth|referer|denied|quota|billing|invalid/i.test(lastError.message)) throw lastError;
    }
  }
  if (lastError && !/ZERO_RESULTS/i.test(lastError.message)) throw lastError;
  return null;
}
