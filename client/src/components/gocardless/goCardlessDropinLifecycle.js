export const GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS = 15000;

function noop() {}

/**
 * Owns the imperative lifetime of one GoCardless Drop-in handler.
 *
 * The SDK invokes onExit when handler.exit() is called, so terminal state is
 * recorded before programmatic cleanup. This keeps cleanup from being
 * presented to the payer as an abandoned authorisation.
 */
export function createGoCardlessDropinLifecycle(callbacks = {}) {
  let currentCallbacks = callbacks;
  let status = 'active';
  let opened = false;
  const exitedHandlers = new Set();

  const exitHandler = (exit = noop) => {
    if (typeof exit !== 'function' || exitedHandlers.has(exit)) return;
    exitedHandlers.add(exit);
    try {
      exit();
    } catch {
      // Cleanup is best-effort and must not replace the original SDK failure.
    }
  };

  const lifecycle = {
    updateCallbacks(nextCallbacks) {
      currentCallbacks = nextCallbacks || {};
    },

    // React StrictMode replays effect setup/cleanup while preserving refs.
    // Reactivation is allowed only after that programmatic cleanup state.
    activate() {
      if (status === 'cleanup') {
        status = 'active';
        opened = false;
      }
    },

    open(open, exit) {
      if (status !== 'active' || opened) return false;
      opened = true;
      try {
        open();
        return true;
      } catch (error) {
        lifecycle.fail(error, exit);
        return false;
      }
    },

    succeed(billingRequest, billingRequestFlow) {
      if (status !== 'active') return false;
      status = 'success';
      currentCallbacks.onSuccess?.(billingRequest, billingRequestFlow);
      return true;
    },

    userExit(error, metadata) {
      if (status !== 'active') return false;
      status = 'user-exit';
      currentCallbacks.onExit?.(error || null, metadata || {});
      return true;
    },

    fail(error, exit) {
      if (status !== 'active') return false;
      status = 'failure';
      exitHandler(exit);
      currentCallbacks.onLoadFailure?.(error);
      return true;
    },

    timeout(exit) {
      if (opened) return false;
      return lifecycle.fail(
        new Error('GoCardless Drop-in did not load in time'),
        exit,
      );
    },

    dispose(exit) {
      if (status === 'active') status = 'cleanup';
      exitHandler(exit);
    },
  };

  return lifecycle;
}

export function scheduleGoCardlessDropinLoadTimeout(
  lifecycle,
  getExit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onTimeout = null,
  timeoutMs = GOCARDLESS_DROPIN_LOAD_TIMEOUT_MS,
) {
  const timer = setTimer(
    () => {
      if (lifecycle.timeout(getExit())) onTimeout?.();
    },
    timeoutMs,
  );
  return () => clearTimer(timer);
}