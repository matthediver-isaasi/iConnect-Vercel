// Dependency-free and imported BEFORE App/analytics. This namespace is never
// a member session, certificate credential, URL credential or storage value.
let grant = null;
let epoch = 0;
let problem = 'missing';
const listeners = new Set();
const work = new Set();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function route() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const landing = /^\/award-application\/?$/i.test(window.location.pathname);
  const amendment = /^\/FormView\/?$/i.test(window.location.pathname) && params.get('externalApplicant') === '1';
  if (!landing && !amendment) return null;
  const key = landing ? 'applicationId' : 'award_amendment';
  const id = params.get(key);
  if (params.getAll(key).length !== 1 || !uuid.test(id || '') || params.getAll('tenant').length > 1) return null;
  return { id: id.toLowerCase(), landing, hint: JSON.stringify([window.location.origin, params.get('tenant') || '']) };
}
function emit() { epoch += 1; listeners.forEach(listener => listener()); }
function matchesRoute(current) {
  if (!grant || !current || current.id !== grant.id || grant.origin !== window.location.origin) return false;
  if (!Object.hasOwn(grant, 'tenantSlug')) return current.hint === grant.hint;
  try { return grant.readTenant() === grant.tenantSlug; } catch { return false; }
}
export function clearExternalAwardApplicantAccess(reason = 'scope') {
  if (!grant && problem === reason) return;
  grant = null; problem = reason;
  work.forEach(controller => controller.abort()); work.clear(); emit();
}
export function syncExternalAwardApplicantRoute() {
  const current = route();
  const relevant = typeof window !== 'undefined' && (/^\/award-application\/?$/i.test(window.location.pathname)
    || (/^\/FormView\/?$/i.test(window.location.pathname) && new URLSearchParams(window.location.search).has('externalApplicant')));
  if (relevant && window.location.hash) {
    const fragment = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    clearExternalAwardApplicantAccess('invalid');
    const match = /^token=([A-Za-z0-9_-]{43})$/.exec(fragment);
    // A form URL is never a second token-entry endpoint.
    if (current?.landing && match) {
      grant = { id: current.id, origin: window.location.origin, hint: current.hint, token: match[1], serial: epoch + 1 };
      problem = ''; emit();
    }
  }
  if (grant && !matchesRoute(current)) clearExternalAwardApplicantAccess('scope');
}
export const subscribeExternalAwardApplicant = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const externalAwardApplicantEpoch = () => epoch;
export const externalAwardApplicantProblem = () => problem;

export function externalAwardApplicantAuthority(applicationId, tenantSlug, readTenant) {
  const current = route();
  if (!grant || !current || current.id !== applicationId?.toLowerCase() || !matchesRoute(current)) return null;
  if (Object.hasOwn(grant, 'tenantSlug') && grant.tenantSlug !== tenantSlug) return null;
  grant.tenantSlug = tenantSlug;
  grant.readTenant = readTenant;
  const serial = grant.serial;
  return {
    externalApplicant: true, status: 'ready', applicationId: current.id, tenantSlug,
    scopeKey: JSON.stringify(['external-award-applicant', serial, tenantSlug, applicationId.toLowerCase()]),
    assertCurrent() {
      const now = route();
      if (!grant || grant.serial !== serial || !matchesRoute(now) || readTenant() !== tenantSlug) {
        throw new Error('Secure application access changed. Reopen the original link; no member-session fallback is available.');
      }
    },
  };
}
export function bindExternalAwardApplicantTenant(authority, tenantId) {
  authority.assertCurrent();
  if (!uuid.test(tenantId || '') || (grant.tenantId && grant.tenantId !== tenantId)) {
    clearExternalAwardApplicantAccess('scope');
    throw new Error('The authorised application organisation changed. Reopen the original link.');
  }
  grant.tenantId = tenantId;
}

export async function externalAwardApplicantWork(authority, signal, callback) {
  authority.assertCurrent();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); work.add(controller);
  const assertCurrent = () => { authority.assertCurrent(); if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError'); };
  try { assertCurrent(); const result = await callback(controller.signal, assertCurrent); assertCurrent(); return result; }
  finally { work.delete(controller); signal?.removeEventListener('abort', abort); }
}

export async function externalAwardApplicantResponse(authority, { edit, issueId, review = false, attachmentId, offset, payload, signal } = {}, consume) {
  if ((attachmentId && (!review || !uuid.test(attachmentId))) || (offset !== undefined && (!attachmentId || !Number.isSafeInteger(offset) || offset < 0 || offset >= 25 * 1024 * 1024))
    || (review && (edit || issueId || payload))) throw new Error('The secure evidence request options are invalid.');
  return externalAwardApplicantWork(authority, signal, async (requestSignal, assertCurrent) => {
    const params = new URLSearchParams();
    if (authority.tenantSlug) params.set('tenant', authority.tenantSlug);
    if (!payload) {
      params.set('applicationId', authority.applicationId);
      if (edit) params.set('edit', '1');
      if (issueId) params.set('issueId', issueId);
      if (review) params.set('review', '1');
      if (attachmentId) { params.set('attachmentId', attachmentId); params.set('offset', String(offset ?? 0)); }
    }
    if (payload && payload.applicationId !== authority.applicationId) throw new Error('This credential cannot change another application.');
    const headers = { Accept: attachmentId ? 'application/octet-stream' : issueId ? 'application/pdf' : 'application/json', 'X-Awards-Applicant': grant.token };
    if (authority.tenantSlug) headers['X-Tenant-Slug'] = authority.tenantSlug;
    if (grant.tenantId) headers['X-Tenant-Id'] = grant.tenantId;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['X-Awards-Request'] = '1'; }
    const response = await fetch(`/api/awards/external-application${params.size ? `?${params}` : ''}`, {
      method: payload ? 'POST' : 'GET', headers, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: requestSignal,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    try {
      assertCurrent();
      if ([401, 403, 404, 410].includes(response.status)) {
        clearExternalAwardApplicantAccess('unavailable');
        throw new Error('Secure applicant access expired, was revoked or is unavailable. Ask the award administrator to resend an authorised link.');
      }
      return await consume(response, assertCurrent);
    } finally { try { await response.body?.cancel(); } catch { /* Drop revoked/failed bodies. */ } }
  });
}

if (typeof window !== 'undefined') {
  syncExternalAwardApplicantRoute();
  // Committed React Router changes call syncExternalAwardApplicantRoute.
  // Do not clear on raw POP: the dirty-navigation guard may restore that POP
  // and the applicant must still be able to choose "Stay" with their draft.
  window.addEventListener('tenant-context-changed', () => clearExternalAwardApplicantAccess('scope'));
  window.addEventListener('storage', event => {
    if (event.key === null || ['tenant_slug', 'activeTenantId'].includes(event.key)) clearExternalAwardApplicantAccess('scope');
  });
  window.addEventListener('pagehide', () => clearExternalAwardApplicantAccess('scope'));
}
