import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationTles, type SatelliteCatalog, type TleRecord } from "@/lib/celestrak";
import { fetchAircraftSnapshot, type AircraftFeedMeta, type AircraftQuery } from "@/lib/aircraft";
import { fetchMilitarySnapshot, type MilitaryFeedMeta } from "@/lib/military";
import type { SpatialEntity } from "@/lib/spatial";
import type { LayerLoadState } from "@/lib/layer-runtime";

export type CoreLayerKey = "earthquakes" | "satellites" | "aircraft" | "military";

type LayerCell<T, M = never> = {
  enabled: boolean;
  status: LayerLoadState;
  data: T;
  meta: M | null;
  error?: string;
  updatedAt: number | null;
};

export type CoreLiveWorldSnapshot = {
  earthquakes: LayerCell<SpatialEntity[]>;
  satellites: LayerCell<TleRecord[]>;
  aircraft: LayerCell<SpatialEntity[], AircraftFeedMeta>;
  military: LayerCell<SpatialEntity[], MilitaryFeedMeta>;
};

const INTERVALS: Record<CoreLayerKey, number> = {
  earthquakes: 60_000,
  satellites: 300_000,
  aircraft: 15_000,
  military: 15_000,
};

function cell<T, M = never>(data: T): LayerCell<T, M> {
  return { enabled: true, status: "idle", data, meta: null, updatedAt: null };
}

/**
 * GEV-derived source/lifecycle owner for the first World Select runtime transplant.
 * Network cadence is independent per layer; failures retain last-good data and
 * cannot erase successful state from another source.
 */
export function createCoreLiveWorld() {
  let snapshot: CoreLiveWorldSnapshot = {
    earthquakes: cell<SpatialEntity[]>([]),
    satellites: cell<TleRecord[]>([]),
    aircraft: cell<SpatialEntity[], AircraftFeedMeta>([]),
    military: cell<SpatialEntity[], MilitaryFeedMeta>([]),
  };
  let started = false;
  let aircraftContext: AircraftQuery | null = null;
  let satelliteCatalog: SatelliteCatalog = "core";
  const listeners = new Set<(value: CoreLiveWorldSnapshot) => void>();
  const controllers = new Map<CoreLayerKey, AbortController>();
  const timers = new Map<CoreLayerKey, ReturnType<typeof setInterval>>();
  const inFlight = new Set<CoreLayerKey>();

  const publish = () => {
    for (const listener of [...listeners]) listener(snapshot);
  };

  const patch = <K extends CoreLayerKey>(
    key: K,
    value: Partial<CoreLiveWorldSnapshot[K]>,
  ) => {
    snapshot = {
      ...snapshot,
      [key]: { ...snapshot[key], ...value },
    };
    publish();
  };

  const fail = (key: CoreLayerKey, error: unknown) => {
    const current = snapshot[key];
    const hasData = Array.isArray(current.data) && current.data.length > 0;
    patch(key as never, {
      status: hasData ? "degraded" : "error",
      error: error instanceof Error ? error.message : String(error || "source unavailable"),
    } as never);
  };

  const refresh = async (key: CoreLayerKey) => {
    const current = snapshot[key];
    if (!current.enabled || inFlight.has(key)) return false;
    if (key === "aircraft" && !aircraftContext) return false;

    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    inFlight.add(key);
    if (!Array.isArray(current.data) || current.data.length === 0) {
      patch(key as never, { status: "loading", error: undefined } as never);
    }

    try {
      if (key === "earthquakes") {
        const data = await fetchEarthquakes(controller.signal);
        if (controller.signal.aborted) return false;
        patch("earthquakes", { data, status: "ready", error: undefined, updatedAt: Date.now() });
      } else if (key === "satellites") {
        const data = await fetchStationTles(controller.signal, satelliteCatalog);
        if (controller.signal.aborted) return false;
        patch("satellites", {
          data,
          status: data.length ? "ready" : "error",
          error: data.length ? undefined : "CelesTrak returned no satellite elements",
          updatedAt: Date.now(),
        });
      } else if (key === "aircraft") {
        const result = await fetchAircraftSnapshot(aircraftContext!, controller.signal);
        if (controller.signal.aborted) return false;
        patch("aircraft", {
          data: result.entities,
          meta: result.meta,
          status: result.entities.length
            ? (result.meta.stale || result.meta.degraded ? "degraded" : "ready")
            : "error",
          error: result.entities.length ? undefined : "No positioned civil aircraft returned",
          updatedAt: Date.now(),
        });
      } else {
        const result = await fetchMilitarySnapshot(controller.signal);
        if (controller.signal.aborted) return false;
        patch("military", {
          data: result.entities,
          meta: result.meta,
          status: result.entities.length
            ? (result.meta.stale || result.meta.degraded ? "degraded" : "ready")
            : "error",
          error: result.entities.length ? undefined : "No positioned military aircraft returned",
          updatedAt: Date.now(),
        });
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted) fail(key, error);
      return false;
    } finally {
      inFlight.delete(key);
      if (controllers.get(key) === controller) controllers.delete(key);
    }
  };

  const arm = (key: CoreLayerKey) => {
    const previous = timers.get(key);
    if (previous) clearInterval(previous);
    timers.set(key, setInterval(() => {
      void refresh(key);
    }, INTERVALS[key]));
  };

  return {
    start() {
      if (started) return;
      started = true;
      (Object.keys(INTERVALS) as CoreLayerKey[]).forEach((key) => {
        arm(key);
        void refresh(key);
      });
    },

    subscribe(listener: (value: CoreLiveWorldSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },

    setEnabled(key: CoreLayerKey, enabled: boolean) {
      const current = snapshot[key];
      if (current.enabled === enabled) return;
      if (!enabled) {
        controllers.get(key)?.abort();
        patch(key as never, { enabled: false, status: "idle", error: undefined } as never);
        return;
      }
      patch(key as never, { enabled: true, status: current.data.length ? "ready" : "loading", error: undefined } as never);
      if (started) void refresh(key);
    },

    setSatelliteCatalog(catalog: SatelliteCatalog) {
      if (satelliteCatalog === catalog) return;
      satelliteCatalog = catalog;
      if (started && snapshot.satellites.enabled) void refresh("satellites");
    },

    setAircraftContext(query: AircraftQuery) {
      const next: AircraftQuery = {
        latitude: Number(query.latitude.toFixed(4)),
        longitude: Number(query.longitude.toFixed(4)),
        radiusNm: query.radiusNm,
      };
      const prior = aircraftContext;
      aircraftContext = next;
      const changed = !prior ||
        prior.latitude !== next.latitude ||
        prior.longitude !== next.longitude ||
        prior.radiusNm !== next.radiusNm;
      if (changed && started && snapshot.aircraft.enabled) void refresh("aircraft");
    },

    retry(key: CoreLayerKey) {
      if (started && snapshot[key].enabled) void refresh(key);
    },

    destroy() {
      started = false;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      inFlight.clear();
      listeners.clear();
    },
  };
}
