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
    __worldSelectGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 8_000;
const STREET_COVERAGE_TIMEOUT_MS = 5_000;
const STREET_SEARCH_RADII_M = [120, 250, 500];
const authFailureListeners = new Set<(message: string) => void>();
let authDispatcherInstalled = false;

function installGoogleAuthDispatcher() {
  if (authDispatcherInstalled) return;
  authDispatcherInstalled = true;
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    try { previous?.(); } catch {}
    const message = 'Google Maps authentication/referrer check failed';
    for (const listener of [...authFailureListeners]) {
      try { listener(message); } catch {}
    }
  };
}

export function onGoogleMapsAuthFailure(listener: (message: string) => void) {
  installGoogleAuthDispatcher();
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

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

  installGoogleAuthDispatcher();

  const staleScript = document.querySelector<HTMLScriptElement>('script[data-world-select-google-maps="1"]');
  if (staleScript && !window.google?.maps) staleScript.remove();

  const promise = new Promise<any>((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    let removeAuthListener: (() => void) | null = null;

    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.dataset.worldSelectGoogleMaps = '1';

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer != null) window.clearTimeout(timer);
      removeAuthListener?.();
      if (error) {
        if (!window.google?.maps) script.remove();
        window.__worldSelectGoogleMapsReady = () => {};
        reject(error);
        return;
      }
      window.__worldSelectGoogleMapsReady = () => {};
      if (window.google?.maps) resolve(window.google);
      else reject(new Error('Google Maps callback fired without maps library'));
    };

    window.__worldSelectGoogleMapsReady = () => finish();
    removeAuthListener = onGoogleMapsAuthFailure((message) => finish(new Error(message)));
    script.addEventListener('error', () => finish(new Error('Google Maps JavaScript API could not be loaded')), { once: true });
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__worldSelectGoogleMapsReady`;
    timer = window.setTimeout(
      () => finish(timeoutError('Google Maps JavaScript API', GOOGLE_MAPS_LOAD_TIMEOUT_MS)),
      GOOGLE_MAPS_LOAD_TIMEOUT_MS,
    );
    document.head.appendChild(script);
  });

  window.__worldSelectGoogleMapsPromise = promise.catch((error) => {
    window.__worldSelectGoogleMapsPromise = undefined;
    throw error;
  });
  return window.__worldSelectGoogleMapsPromise;
}

export function loadGoogleStreetView(apiKey: string): Promise<GoogleStreetViewLibrary> {export function loadGoogleStreetView(apiKey: string): Promise<GoogleStreetViewLibrary> {
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
