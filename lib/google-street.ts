export type GoogleStreetCoverage = {
  panoId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type GoogleStreetViewLibrary = {
  google: any;
  StreetViewService: any;
  StreetViewPanorama: any;
  StreetViewStatus: any;
  StreetViewSource: any;
  StreetViewPreference: any;
};

declare global {
  interface Window {
    google?: any;
    __worldSelectGoogleMapsPromise?: Promise<any>;
    __worldSelectGoogleStreetPromise?: Promise<GoogleStreetViewLibrary>;
    gm_authFailure?: () => void;
  }
}

const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 8_000;
const STREET_COVERAGE_TIMEOUT_MS = 5_000;
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

export function loadGoogleMaps(apiKey: string): Promise<any> {
  const key = String(apiKey || '').trim();
  if (!key) return Promise.reject(new Error('Google Maps API key is not configured'));
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__worldSelectGoogleMapsPromise) return window.__worldSelectGoogleMapsPromise;

  const promise = new Promise<any>((resolve, reject) => {
    const previousAuthFailure = window.gm_authFailure;
    const finishAuthFailure = () => {
      try { previousAuthFailure?.(); } catch {}
      reject(new Error('Google Maps authentication/referrer check failed'));
    };
    window.gm_authFailure = finishAuthFailure;

    const loaded = () => {
      if (window.gm_authFailure === finishAuthFailure) window.gm_authFailure = previousAuthFailure;
      if (window.google?.maps) resolve(window.google);
      else reject(new Error('Google Maps loaded without maps library'));
    };
    const failed = () => {
      if (window.gm_authFailure === finishAuthFailure) window.gm_authFailure = previousAuthFailure;
      reject(new Error('Google Maps JavaScript API could not be loaded'));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
    if (existing) {
      if (window.google?.maps) {
        loaded();
        return;
      }
      existing.addEventListener('load', loaded, { once: true });
      existing.addEventListener('error', failed, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`;
    script.async = true;
    script.defer = true;
    script.dataset.worldSelectGoogleMaps = '1';
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    document.head.appendChild(script);
  });

  window.__worldSelectGoogleMapsPromise = withTimeout(
    promise,
    GOOGLE_MAPS_LOAD_TIMEOUT_MS,
    'Google Maps JavaScript API',
  ).catch((error) => {
    window.__worldSelectGoogleMapsPromise = undefined;
    throw error;
  });
  return window.__worldSelectGoogleMapsPromise;
}

export function loadGoogleStreetView(apiKey: string): Promise<GoogleStreetViewLibrary> {
  if (window.__worldSelectGoogleStreetPromise) return window.__worldSelectGoogleStreetPromise;

  window.__worldSelectGoogleStreetPromise = loadGoogleMaps(apiKey)
    .then(async (google) => {
      if (typeof google?.maps?.importLibrary !== 'function') {
        throw new Error('Google Maps importLibrary is unavailable');
      }
      const library = await google.maps.importLibrary('streetView');
      const StreetViewService = library?.StreetViewService ?? google.maps.StreetViewService;
      const StreetViewPanorama = library?.StreetViewPanorama ?? google.maps.StreetViewPanorama;
      const StreetViewStatus = library?.StreetViewStatus ?? google.maps.StreetViewStatus;
      const StreetViewSource = library?.StreetViewSource ?? google.maps.StreetViewSource;
      const StreetViewPreference = library?.StreetViewPreference ?? google.maps.StreetViewPreference;
      if (typeof StreetViewService !== 'function' || typeof StreetViewPanorama !== 'function') {
        throw new Error('Google Street View library loaded without constructors');
      }
      return {
        google,
        StreetViewService,
        StreetViewPanorama,
        StreetViewStatus,
        StreetViewSource,
        StreetViewPreference,
      };
    })
    .catch((error) => {
      window.__worldSelectGoogleStreetPromise = undefined;
      throw error;
    });

  return window.__worldSelectGoogleStreetPromise;
}

function requestStreetPanorama(
  street: GoogleStreetViewLibrary,
  service: any,
  point: { latitude: number; longitude: number },
  radiusMeters: number,
): Promise<GoogleStreetCoverage | null> {
  return withTimeout(new Promise<GoogleStreetCoverage | null>((resolve, reject) => {
    const request: Record<string, unknown> = {
      location: { lat: point.latitude, lng: point.longitude },
      radius: radiusMeters,
    };
    if (street.StreetViewPreference?.NEAREST) request.preference = street.StreetViewPreference.NEAREST;
    if (street.StreetViewSource?.OUTDOOR) request.source = street.StreetViewSource.OUTDOOR;

    const settle = (data: any, status: any) => {
      const ok = status === street.StreetViewStatus?.OK || String(status) === 'OK';
      const zero = status === street.StreetViewStatus?.ZERO_RESULTS || String(status) === 'ZERO_RESULTS';
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
    };

    try {
      const maybePromise = service.getPanorama(request, settle);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((response: any) => settle(response?.data, response?.status ?? street.StreetViewStatus?.OK)).catch(reject);
      }
    } catch (error) {
      reject(error);
    }
  }), STREET_COVERAGE_TIMEOUT_MS, `Google Street View ${radiusMeters} m coverage check`);
}

export async function findGoogleStreetCoverage(
  apiKey: string,
  point: { latitude: number; longitude: number },
  radiusMeters = 120,
): Promise<GoogleStreetCoverage | null> {
  const street = await loadGoogleStreetView(apiKey);
  const service = new street.StreetViewService();
  const radii = Array.from(new Set([radiusMeters, ...STREET_SEARCH_RADII_M]))
    .filter((radius) => Number.isFinite(radius) && radius > 0 && radius <= 500);

  let lastError: Error | null = null;
  for (const radius of radii) {
    try {
      const result = await requestStreetPanorama(street, service, point, radius);
      if (result) return result;
    } catch (reason) {
      lastError = reason instanceof Error ? reason : new Error('Google Street View coverage check failed');
      if (/auth|referer|denied|quota|billing|invalid/i.test(lastError.message)) throw lastError;
    }
  }
  if (lastError && !/ZERO_RESULTS/i.test(lastError.message)) throw lastError;
  return null;
}
