export type ApplicationPhase = "scene" | "controls" | "data" | "tools";
export type ApplicationState = { status: "created" | "starting" | "ready" | "destroying" | "destroyed" | "failed"; phase: ApplicationPhase | null };

const START_ORDER: ApplicationPhase[] = ["scene", "controls", "data", "tools"];
const STOP_ORDER: ApplicationPhase[] = ["tools", "controls", "data", "scene"];

type FactoryContext = {
  signal: AbortSignal;
  defer(dispose: () => void | Promise<void>): void;
  [key: string]: unknown;
};

type Factory = (context: FactoryContext) => unknown | Promise<unknown>;

/** Adapted from God's Eye View application ownership: startup is phased,
 * cleanup is registered at acquisition time, and teardown runs in reverse.
 */
export function createApplication(factories: Record<ApplicationPhase, Factory>) {
  const controller = new AbortController();
  const cleanups = Object.fromEntries(START_ORDER.map((phase) => [phase, [] as Array<() => void | Promise<void>>])) as Record<ApplicationPhase, Array<() => void | Promise<void>>>;
  const components: Partial<Record<ApplicationPhase, unknown>> = {};
  const listeners = new Set<(state: ApplicationState) => void>();
  let state: ApplicationState = { status: "created", phase: null };
  let startPromise: Promise<Readonly<Partial<Record<ApplicationPhase, unknown>>>> | null = null;
  let destroyPromise: Promise<void> | null = null;

  const publish = (status: ApplicationState["status"], phase: ApplicationPhase | null = null) => {
    state = { status, phase };
    for (const listener of [...listeners]) listener(state);
  };

  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const phase of STOP_ORDER) {
      while (cleanups[phase].length) {
        try { await cleanups[phase].pop()?.(); } catch (error) { errors.push(error); }
      }
      delete components[phase];
    }
    if (errors.length) throw new AggregateError(errors, "Application cleanup failed");
  };

  const initialize = async () => {
    try {
      for (const phase of START_ORDER) {
        controller.signal.throwIfAborted();
        publish("starting", phase);
        let acceptingCleanup = true;
        try {
          components[phase] = await factories[phase]({
            ...components,
            signal: controller.signal,
            defer(dispose) {
              if (!acceptingCleanup || typeof dispose !== "function") throw new TypeError("Register cleanup during construction");
              cleanups[phase].push(dispose);
            },
          });
        } finally {
          acceptingCleanup = false;
        }
      }
      publish("ready");
      return Object.freeze({ ...components });
    } catch (error) {
      controller.abort();
      await cleanup().catch(() => {});
      publish("failed");
      throw error;
    }
  };

  return Object.freeze({
    start() {
      startPromise ??= Promise.resolve().then(initialize);
      return startPromise;
    },
    destroy() {
      destroyPromise ??= Promise.resolve().then(async () => {
        controller.abort();
        publish("destroying");
        await startPromise?.catch(() => {});
        await cleanup();
        publish("destroyed");
        listeners.clear();
      });
      return destroyPromise;
    },
    getState: () => state,
    getComponents: () => Object.freeze({ ...components }),
    subscribe(listener: (next: ApplicationState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  });
}
