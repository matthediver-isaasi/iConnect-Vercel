import { useEffect } from 'react';

const requests = new Map();

export const VIEWER_SESSION_REVALIDATE_MS = 5 * 60 * 1000;

function cancelledError() {
  const error = new Error('Viewer session request was cancelled');
  error.name = 'AbortError';
  return error;
}

function startRequest(scope, fetchImpl) {
  const controller = new AbortController();
  const entry = {
    controller,
    leases: 0,
    settled: false,
    invalidated: false,
    promise: null,
  };
  entry.promise = fetchImpl('/api/auth/me', {
    credentials: 'include',
    signal: controller.signal,
  }).then(async (response) => {
    if (entry.invalidated) throw cancelledError();
    const member = response.ok ? await response.json() : null;
    if (entry.invalidated) throw cancelledError();
    return { response, member };
  }).finally(() => {
    entry.settled = true;
    if (entry.leases === 0 && requests.get(scope) === entry) requests.delete(scope);
  });
  // A preload may be aborted before an auth consumer attaches. Keep that
  // expected rejection handled without changing the promise consumers await.
  entry.promise.catch(() => {});
  requests.set(scope, entry);
  return entry;
}

export function acquireViewerSessionRequest(scope, fetchImpl = fetch) {
  const entry = requests.get(scope) || startRequest(scope, fetchImpl);
  entry.leases += 1;
  let active = true;
  return {
    // Resolve through the entry at consumption time. A lease retained a
    // reference may outlive logout even when the network response had already
    // settled, so returning the raw fulfilled promise here would bypass
    // invalidation.
    get promise() {
      return entry.promise.then(result => {
        if (entry.invalidated) throw cancelledError();
        return result;
      });
    },
    cancel() {
      if (!active) return;
      active = false;
      entry.leases -= 1;
      if (entry.leases === 0) {
        entry.invalidated = true;
        if (!entry.settled) {
          entry.controller.abort();
        }
        if (requests.get(scope) === entry) requests.delete(scope);
      }
    },
  };
}

export function invalidateViewerSessionRequest(scope) {
  const entry = requests.get(scope);
  if (!entry) return;
  requests.delete(scope);
  entry.invalidated = true;
  if (!entry.settled) {
    entry.controller.abort();
  }
}

export function getViewerSessionScope({
  tenantSlug,
  hostname,
  authRevision,
}) {
  // tenantSlug is derived synchronously from the request host by publicClient,
  // unlike branding data which arrives asynchronously. Custom-domain tenants
  // use the hostname itself as their stable request boundary.
  const tenant = tenantSlug || hostname;
  // Route transitions are not authentication boundaries. Only an explicit
  // generation change (login/logout, account change, retry, or bounded
  // revalidation) may start a new viewer request.
  return `${tenant}:${authRevision}`;
}

export function isViewerSessionRevalidationDue(
  validatedAt,
  now = Date.now(),
  maxAge = VIEWER_SESSION_REVALIDATE_MS,
) {
  return !Number.isFinite(validatedAt)
    || validatedAt <= 0
    || now - validatedAt >= maxAge;
}

/**
 * Starts the raw, parse-once session request independently of visibility
 * settings. Auth state is deliberately not committed here; Layout's guarded
 * auth effect remains the only consumer allowed to apply the response.
 */
export function useViewerSessionPreload(scope) {
  useEffect(() => {
    const lease = acquireViewerSessionRequest(scope);
    return () => lease.cancel();
  }, [scope]);
}