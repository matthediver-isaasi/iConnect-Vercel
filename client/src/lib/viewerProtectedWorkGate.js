// Recovery never queues/replays requests (especially mutations). Previously
// validated view state may be retained, but it is not a licence for new work.
let paused = false;
let generation = 0;
let originalFetch;
let rejectionCheck;

export function setViewerProtectedWorkPaused(value) {
  if (paused === value) return;
  paused = value;
  generation += 1;
}

export function invalidateViewerProtectedWork() {
  generation += 1;
  rejectionCheck = undefined;
}

async function confirmsRejectedSession(fetchImpl, epoch) {
  if (rejectionCheck?.epoch === epoch) return rejectionCheck.promise;
  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetchImpl('/api/auth/me', {
        credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      return response.ok && await response.json() === null;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })();
  rejectionCheck = { epoch, promise };
  try { return await promise; }
  finally { if (rejectionCheck?.promise === promise) rejectionCheck = undefined; }
}

function pausedError() {
  const error = new Error('Session verification is unavailable. Retry after reconnecting.');
  error.code = 'VIEWER_SESSION_WORK_PAUSED';
  return error;
}

// Only endpoints whose operation is intrinsically public/guest-only belong
// here. Mixed member/guest booking/payment operations remain protected during
// retained-member recovery; confirmed guests run them with the gate open.
const publicFunctionMethods = new Map([
  ['getStripePublishableKey', new Set(['GET', 'POST'])],
  ['checkMemberStatusByEmail', new Set(['POST'])],
  ['createJobPostingNonMember', new Set(['POST'])],
  ['createJobPostingPaymentIntent', new Set(['POST'])],
]);

export function viewerSessionFailureRetainsWorkPause(isRoutineRevalidation, serverResponded) {
  return !!isRoutineRevalidation && !serverResponded;
}

export function isProtectedViewerRequest(input, origin, options = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
  const method = (options.method || input?.method || 'GET').toUpperCase();
  if (url.origin !== origin || !url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/api/auth/')) return false;
  if (url.pathname.startsWith('/api/public/')) return false;
  const functionName = url.pathname.startsWith('/api/functions/')
    ? url.pathname.slice('/api/functions/'.length) : null;
  if (publicFunctionMethods.get(functionName)?.has(method)) return false;
  return true;
}

export function installViewerProtectedWorkGate(target = window) {
  const fetchImpl = target.fetch;
  originalFetch = fetchImpl.bind(target);
  const wrapper = async (input, options) => {
    const protectedRequest = isProtectedViewerRequest(input, target.location.origin, options);
    if (protectedRequest && paused) throw pausedError();
    const epoch = generation;
    const response = await fetchImpl.call(target, input, options);
    if (protectedRequest && (paused || epoch !== generation)) throw pausedError();
    // 403 alone can mean a feature denial. Only session-specific evidence
    // invalidates identity, and never a late response from a previous epoch.
    if (protectedRequest && [401, 403].includes(response.status)) {
      const rejected = response.headers?.get('X-Session-Status') === 'invalid'
        || (response.status === 401 && await confirmsRejectedSession(originalFetch, epoch));
      if (epoch !== generation || paused) throw pausedError();
      if (rejected) {
        invalidateViewerProtectedWork();
        target.dispatchEvent?.(new Event('viewer-session-rejected'));
        throw pausedError();
      }
    }
    if (protectedRequest) {
      // Parsing can outlive fetch resolution too; fence the value before a
      // query/mutation consumer can publish it into the retained page.
      return new Proxy(response, {
        get(object, key) {
          const value = Reflect.get(object, key, object);
          if (['json', 'text', 'blob', 'arrayBuffer', 'formData'].includes(key) && typeof value === 'function') {
            return async (...args) => {
              const body = await value.apply(object, args);
              if (paused || epoch !== generation) throw pausedError();
              return body;
            };
          }
          return typeof value === 'function' ? value.bind(object) : value;
        },
      });
    }
    return response;
  };
  target.fetch = wrapper;
  return () => {
    if (target.fetch === wrapper) target.fetch = fetchImpl;
    setViewerProtectedWorkPaused(false);
  };
}

// Narrow read-only recovery capability, not a general bypass for page callers.
export async function fetchViewerSessionRole(roleId) {
  const response = await (originalFetch || fetch)(
    `/api/entities/Role/${encodeURIComponent(roleId)}`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`Session role validation failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}