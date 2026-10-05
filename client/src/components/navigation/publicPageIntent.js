export const PUBLIC_PAGE_INTENT_DELAY_MS = 100;
export const PUBLIC_PAGE_INTENT_LIFETIME_MS = 5_000;

const sameRequest = (a, b) => a?.slug === b?.slug && a?.micrositePrefix === b?.micrositePrefix;
const aborted = () => new DOMException('Navigation request cancelled', 'AbortError');

/**
 * One target, in-flight only. This is deliberately not a completed-response
 * cache: an unactivated intent drops its payload on completion. Actual clicks
 * can adopt the pending transport, but still pass through DynamicPage's gates.
 * Superseded transports are aborted; at most two may be awaiting transport
 * settlement, and only the latest target may wait for a slot.
 */
export function createPublicPageIntentPool(read, { lifetimeMs = PUBLIC_PAGE_INTENT_LIFETIME_MS } = {}) {
  const running = new Set();
  let current = null;
  const clear = () => {
    if (current) current.result = undefined;
    current?.controller.abort();
    current = null;
  };
  const acquire = (scope, request, activate = false) => {
    if (current && !current.finished && !current.controller.signal.aborted
      && current.scope === scope && sameRequest(current.request, request)) {
      if (activate) {
        current.activated = true;
        clearTimeout(current.expiry);
      }
      return current;
    }
    clear();
    const controller = new AbortController();
    const task = { scope, request, controller, activated: activate, finished: false };
    current = task;
    task.promise = (async () => {
      while (running.size >= 2) {
        let onAbort;
        try {
          await Promise.race([
            ...[...running].map(item => item.settled),
            new Promise((_, reject) => {
              onAbort = () => reject(aborted());
              controller.signal.addEventListener('abort', onAbort, { once: true });
              if (controller.signal.aborted) onAbort();
            }),
          ]);
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      }
      if (controller.signal.aborted) throw aborted();
      running.add(task);
      return read(request, controller.signal);
    })();
    task.settled = task.promise.then(result => {
      // A clicked navigation may hand off its result exactly once. A mere
      // hover/focus must never establish retained cookie-bearing authority.
      if (task.activated && current === task && !controller.signal.aborted) task.result = result;
    }, () => {}).finally(() => {
      task.finished = true;
      running.delete(task);
      clearTimeout(task.expiry);
      if (!task.activated && current === task) current = null;
    });
    if (!activate) task.expiry = setTimeout(() => controller.abort(), lifetimeMs);
    return task;
  };
  return { acquire, clear };
}
