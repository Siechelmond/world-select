import { fetchEarthquakes } from "@/lib/usgs";
import { fetchStationTles, type SatelliteCatalog, type TleRecord } from "@/lib/celestrak";
import { fetchAircraftSnapshot, type AircraftFeedMeta, type AircraftQuery } from "@/lib/aircraft";
import { fetchMilitarySnapshot, type MilitaryFeedMeta } from "@/lib/military";
import type { SpatialEntity } from "@/lib/spatial";
import type { LayerLoadState } from "@/lib/layer-runtime";
import { createLayerLifecycle, type LayerUpdateReason } from "@/runtime/gev/layer-lifecycle";

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
  military: 30_000,
};

function cell<T, M = never>(data: T): LayerCell<T, M> {
  return { enabled: true, status: "idle", data, meta: null, updatedAt: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "source unavailable");
}

/**
 * Network/source owner for the World Select GEV foundation runtime.
 * The public contract remains stable for the React shell while lifecycle
 * ownership is delegated to the shared GEV-style LayerLifecycle.
 */
export function createCoreLiveWorld() {
  let snapshot: CoreLiveWorldSnapshot = {
    earthquakes: cell<SpatialEntity[]>([]),
    satellites: cell<TleRecord[]>([]),
    aircraft: cell<SpatialEntity[], AircraftFeedMeta>([]),
    military: cell<SpatialEntity[], MilitaryFeedMeta>([]),
  };
  let aircraftContext: AircraftQuery | null = null;
  let satelliteCatalog: SatelliteCatalog = "core";
  let startPromise: Promise<void> | null = null;
  let destroyPromise: Promise<void> | null = null;
  const listeners = new Set<(value: CoreLiveWorldSnapshot) => void>();
  const lifecycle = createLayerLifecycle();

  const publish = () => {
    for (const listener of [...listeners]) listener(snapshot);
  };

  const patch = <K extends CoreLayerKey>(key: K, value: Partial<CoreLiveWorldSnapshot[K]>) => {
    snapshot = { ...snapshot, [key]: { ...snapshot[key], ...value } };
    publish();
  };

  const fail = (key: CoreLayerKey, error: unknown) => {
    const current = snapshot[key];
    const hasData = Array.isArray(current.data) && current.data.length > 0;
    patch(key as never, {
      status: hasData ? "degraded" : "error",
      error: errorMessage(error),
    } as never);
  };

  const withFailure = async (key: CoreLayerKey, task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      fail(key, error);
      throw error;
    }
  };

  const moduleBase = (key: CoreLayerKey) => ({
    id: key,
    refreshIntervalMs: INTERVALS[key],
    enable() {
      const current = snapshot[key];
      patch(key as never, {
        enabled: true,
        status: Array.isArray(current.data) && current.data.length ? "ready" : "loading",
        error: undefined,
      } as never);
    },
    disable() {
      patch(key as never, { enabled: false, status: "idle", error: undefined } as never);
    },
    getStats() {
      const current = snapshot[key];
      return {
        count: Array.isArray(current.data) ? current.data.length : 0,
        lastUpdate: current.updatedAt,
        status: current.status,
        error: current.error,
      };
    },
  });

  lifecycle.register({
    ...moduleBase("earthquakes"),
    async update({ signal }) {
      await withFailure("earthquakes", async () => {
        const data = await fetchEarthquakes(signal);
        if (signal.aborted) return;
        patch("earthquakes", {
          data,
          status: data.length ? "ready" : "error",
          error: data.length ? undefined : "USGS returned no recent earthquake events",
          updatedAt: Date.now(),
        });
      });
    },
  });

  lifecycle.register({
    ...moduleBase("satellites"),
    async update({ signal }) {
      await withFailure("satellites", async () => {
        const data = await fetchStationTles(signal, satelliteCatalog);
        if (signal.aborted) return;
        patch("satellites", {
          data,
          status: data.length ? "ready" : "error",
          error: data.length ? undefined : "CelesTrak returned no satellite elements",
          updatedAt: Date.now(),
        });
      });
    },
  });

  lifecycle.register({
    ...moduleBase("aircraft"),
    async update({ signal }) {
      if (!aircraftContext) return;
      await withFailure("aircraft", async () => {
        const result = await fetchAircraftSnapshot(aircraftContext!, signal);
        if (signal.aborted) return;
        patch("aircraft", {
          data: result.entities,
          meta: result.meta,
          status: result.entities.length
            ? (result.meta.stale || result.meta.degraded ? "degraded" : "ready")
            : "error",
          error: result.entities.length ? undefined : "No positioned civil aircraft returned",
          updatedAt: Date.now(),
        });
      });
    },
  });

  lifecycle.register({
    ...moduleBase("military"),
    async update({ signal }) {
      await withFailure("military", async () => {
        const result = await fetchMilitarySnapshot(signal);
        if (signal.aborted) return;
        patch("military", {
          data: result.entities,
          meta: result.meta,
          status: result.entities.length
            ? (result.meta.stale || result.meta.degraded ? "degraded" : "ready")
            : "error",
          error: result.entities.length ? undefined : "No positioned military aircraft returned",
          updatedAt: Date.now(),
        });
      });
    },
  });

  const refresh = (key: CoreLayerKey, reason: LayerUpdateReason) => {
    if (!snapshot[key].enabled) return;
    void lifecycle.refresh(key, reason);
  };

  return Object.freeze({
    start() {
      startPromise ??= lifecycle.start(["earthquakes", "satellites", "aircraft", "military"]);
      return startPromise;
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
      void lifecycle.setEnabled(key, enabled);
    },
    setSatelliteCatalog(catalog: SatelliteCatalog) {
      if (satelliteCatalog === catalog) return;
      satelliteCatalog = catalog;
      refresh("satellites", "params");
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
      if (changed) refresh("aircraft", "context");
    },
    retry(key: CoreLayerKey) {
      refresh(key, "retry");
    },
    getLifecycleSnapshot() {
      return lifecycle.getSnapshot();
    },
    destroy() {
      destroyPromise ??= Promise.resolve(startPromise)
        .catch(() => {})
        .then(() => lifecycle.destroy())
        .then(() => { listeners.clear(); });
      return destroyPromise;
    },
  });
}
