export type LayerUpdateReason = "startup" | "interval" | "retry" | "context" | "params";
export type LayerState = "registered" | "initializing" | "disabled" | "enabling" | "enabled" | "disabling" | "failed" | "destroyed";
export type LayerStats = { count: number; lastUpdate: number | null; error?: string; [key: string]: unknown };
export type RuntimeLayer = {
  id: string;
  refreshIntervalMs?: number;
  init?: () => void | Promise<void>;
  enable?: () => void | Promise<void>;
  disable?: () => void | Promise<void>;
  update?: (input: { signal: AbortSignal; reason: LayerUpdateReason }) => void | Promise<void>;
  destroy?: () => void | Promise<void>;
  getStats?: () => LayerStats;
};
export type LifecycleSnapshot = { id: string; enabled: boolean; initialized: boolean; refreshing: boolean; state: LayerState; stats: LayerStats };

type Entry = {
  module: RuntimeLayer;
  enabled: boolean;
  initialized: boolean;
  refreshing: boolean;
  state: LayerState;
  interval: ReturnType<typeof setInterval> | null;
  controller: AbortController | null;
  chain: Promise<void>;
  epoch: number;
  error?: string;
};

/** Compact adaptation of GEV's layer-lifecycle ownership contract. */
export function createLayerLifecycle() {
  const layers = new Map<string, Entry>();
  const listeners = new Set<(value: LifecycleSnapshot[]) => void>();
  let started = false;
  let destroyed = false;

  const entry = (id: string) => {
    const value = layers.get(id);
    if (!value) throw new Error(`Unknown runtime layer: ${id}`);
    return value;
  };
  const stats = (e: Entry): LayerStats => {
    try {
      const value = e.module.getStats?.() ?? { count: 0, lastUpdate: null };
      return e.error && !value.error ? { ...value, error: e.error } : value;
    } catch (error) {
      return { count: 0, lastUpdate: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const snapshot = (): LifecycleSnapshot[] => [...layers.values()].map((e) => ({
    id: e.module.id,
    enabled: e.enabled,
    initialized: e.initialized,
    refreshing: e.refreshing,
    state: e.state,
    stats: stats(e),
  }));
  const publish = () => {
    const value = snapshot();
    for (const listener of [...listeners]) listener(value);
  };
  const stopWork = (e: Entry) => {
    if (e.interval) clearInterval(e.interval);
    e.interval = null;
    e.epoch += 1;
    e.controller?.abort();
    e.controller = null;
    e.refreshing = false;
  };

  const refresh = async (id: string, reason: LayerUpdateReason = "retry") => {
    const e = entry(id);
    if (destroyed || !e.enabled || !e.initialized || e.refreshing || !e.module.update) return false;
    const controller = new AbortController();
    const epoch = ++e.epoch;
    e.controller = controller;
    e.refreshing = true;
    e.error = undefined;
    publish();
    try {
      await e.module.update({ signal: controller.signal, reason });
      return !controller.signal.aborted && e.epoch === epoch && e.enabled;
    } catch (error) {
      if (!controller.signal.aborted && e.epoch === epoch) e.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (e.epoch === epoch) {
        e.controller = null;
        e.refreshing = false;
        publish();
      }
    }
  };

  const initialize = async (e: Entry) => {
    if (e.initialized) return;
    e.state = "initializing";
    publish();
    try {
      await e.module.init?.();
      e.initialized = true;
      e.state = "disabled";
      e.error = undefined;
    } catch (error) {
      e.state = "failed";
      e.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { publish(); }
  };

  const transition = async (e: Entry, enabled: boolean, reason: LayerUpdateReason) => {
    if (destroyed || e.state === "destroyed") return;
    if (!e.initialized) await initialize(e);
    if (e.enabled === enabled && e.state === (enabled ? "enabled" : "disabled")) {
      if (enabled && reason !== "startup") await refresh(e.module.id, reason);
      return;
    }
    if (enabled) {
      e.state = "enabling";
      publish();
      try {
        await e.module.enable?.();
        e.enabled = true;
        e.state = "enabled";
        e.error = undefined;
        const ms = Number(e.module.refreshIntervalMs ?? 0);
        if (Number.isFinite(ms) && ms > 0) e.interval = setInterval(() => { void refresh(e.module.id, "interval"); }, ms);
        publish();
        await refresh(e.module.id, reason);
      } catch (error) {
        stopWork(e);
        e.enabled = false;
        e.state = "failed";
        e.error = error instanceof Error ? error.message : String(error);
        publish();
      }
      return;
    }
    e.state = "disabling";
    publish();
    stopWork(e);
    try {
      await e.module.disable?.();
      e.enabled = false;
      e.state = "disabled";
      e.error = undefined;
    } catch (error) {
      e.enabled = false;
      e.state = "failed";
      e.error = error instanceof Error ? error.message : String(error);
    } finally { publish(); }
  };

  return Object.freeze({
    register(module: RuntimeLayer) {
      if (started || destroyed) throw new Error("Layer registration is closed");
      if (!module?.id || layers.has(module.id)) throw new Error(`Invalid or duplicate runtime layer: ${module?.id ?? "missing"}`);
      layers.set(module.id, { module, enabled: false, initialized: false, refreshing: false, state: "registered", interval: null, controller: null, chain: Promise.resolve(), epoch: 0 });
    },
    async start(initiallyEnabled: Iterable<string> = []) {
      if (started || destroyed) return;
      started = true;
      const wanted = new Set(initiallyEnabled);
      for (const e of layers.values()) {
        await initialize(e);
        if (wanted.has(e.module.id)) e.chain = e.chain.then(() => transition(e, true, "startup"));
      }
      await Promise.all([...layers.values()].map((e) => e.chain));
    },
    setEnabled(id: string, enabled: boolean) {
      const e = entry(id);
      e.chain = e.chain.then(() => transition(e, enabled, "retry"));
      return e.chain;
    },
    refresh,
    isEnabled: (id: string) => entry(id).enabled,
    getSnapshot: snapshot,
    subscribe(listener: (value: LifecycleSnapshot[]) => void) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const e of [...layers.values()].reverse()) {
        stopWork(e);
        await e.chain.catch(() => {});
        if (e.enabled) { try { await e.module.disable?.(); } catch {} }
        try { await e.module.destroy?.(); } catch {}
        e.enabled = false;
        e.initialized = false;
        e.state = "destroyed";
      }
      publish();
      listeners.clear();
      layers.clear();
    },
  });
}
