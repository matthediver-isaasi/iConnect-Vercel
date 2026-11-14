import { getTenantSlugFromLocation } from '@/api/publicClient';
import { readAwardAttachment } from '@/lib/awardEvidenceReader';

const CSRF_KEY = 'iconnect.judging.csrf';
const SESSION_EVENT = 'judging-session-context-changed';

export function readJudgingCsrf() {
  try { return window.sessionStorage.getItem(CSRF_KEY); } catch { return null; }
}

export function subscribeJudgingSession(callback) {
  const storage = event => { if (event.key === CSRF_KEY || event.key === 'tenant_slug' || event.key === null) callback(); };
  window.addEventListener(SESSION_EVENT, callback);
  window.addEventListener('tenant-context-changed', callback);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(SESSION_EVENT, callback);
    window.removeEventListener('tenant-context-changed', callback);
    window.removeEventListener('storage', storage);
  };
}

function judgingTransport(url, authority) {
  authority?.assertCurrent();
  const tenantSlug = authority?.tenantSlug ?? getTenantSlugFromLocation();
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !/^\/api\/judging(?:\/|$)/.test(target.pathname)) {
    throw new Error('Judging requests must use the current site.');
  }
  if (tenantSlug) target.searchParams.set('tenant', tenantSlug);
  return {
    url: target.pathname + target.search,
    assertCurrent() {
      authority?.assertCurrent();
      if (getTenantSlugFromLocation() !== tenantSlug) throw new Error('Your judging organisation changed. Reopen the current assignment before continuing.');
    },
  };
}

export function storeJudgingCsrf(token) {
  if (typeof token !== 'string' || !token) throw new Error('The server did not return judging session verification.');
  try { window.sessionStorage.setItem(CSRF_KEY, token); window.dispatchEvent?.(new Event(SESSION_EVENT)); }
  catch { throw new Error('The invitation was accepted, but this browser could not store session verification. Enable session storage and request a new invitation before saving assessments.'); }
}

export function clearJudgingCsrf() {
  try { window.sessionStorage.removeItem(CSRF_KEY); window.dispatchEvent?.(new Event(SESSION_EVENT)); }
  catch { throw new Error('The server ended the restricted session, but browser verification storage could not be cleared. Close this tab before using another judging invitation.'); }
}

export async function judgingRequest(url, { body, signal, method, authority } = {}) {
  const transport = judgingTransport(url, authority);
  transport.assertCurrent();
  const verb = method || (body === undefined ? 'GET' : 'POST');
  const headers = { Accept: 'application/json' };
  if (verb !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Judging-Request'] = '1';
    try {
      const csrf = window.sessionStorage.getItem(CSRF_KEY);
      if (csrf) headers['X-Judging-Csrf'] = csrf;
    } catch { /* Normal member sessions do not require stored external CSRF. */ }
  }
  let response;
  try {
    response = await fetch(transport.url, {
      method: verb, headers,
      credentials: verb === 'DELETE' ? 'include' : 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (cause.name === 'AbortError') throw cause;
    throw Object.assign(new Error(verb === 'DELETE' ? 'Restricted-session sign-out could not be confirmed. Your local access context has been retained. Retry sign-out to check its outcome.' : 'The connection was interrupted. A save may have reached the server. Retry the unchanged request to check its outcome.'), { network: true });
  }
  transport.assertCurrent();
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error(verb === 'DELETE' ? 'The sign-out response could not be verified. Local access context has not been cleared. Retry sign-out.' : 'The server response could not be read. Retry the unchanged request or reload before editing.'), { status: response.status }); }
  transport.assertCurrent();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Judging request failed.'), { status: response.status, details: result.details });
  return result;
}

export async function judgingAttachmentRequest(assignmentId, attachmentId, { authority, signal } = {}) {
  if (!authority || typeof authority.assertCurrent !== 'function') throw new Error('Current judging authority is required to download an attachment.');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (![assignmentId, attachmentId].every(value => typeof value === 'string' && uuid.test(value))) {
    throw new Error('This attachment does not have a valid assigned review reference.');
  }
  return downloadJudgingAttachment('/api/judging/attachment', { assignmentId, attachmentId }, { authority, signal });
}

export function judgingPanelAttachmentRequest(roundId, applicationId, attachmentId, options) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (![roundId, applicationId, attachmentId].every(value => uuid.test(value || ''))) throw new Error('The panel attachment reference is invalid.');
  return downloadJudgingAttachment('/api/judging/panel', { scope: 'attachment', roundId, applicationId, attachmentId }, options);
}

async function downloadJudgingAttachment(path, params, { authority, signal } = {}) {
  if (!authority || typeof authority.assertCurrent !== 'function') throw new Error('Current judging authority is required.');
  const transport = judgingTransport(path, authority);
  const assertCurrent = () => {
    if (signal?.aborted) throw new DOMException('Attachment download cancelled.', 'AbortError');
    transport.assertCurrent();
  };
  assertCurrent();
  return readAwardAttachment({ signal, assertCurrent, requestChunk: async (offset, chunkSignal, consume) => {
    assertCurrent();
    const target = new URL(transport.url, window.location.origin);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    target.searchParams.set('offset', String(offset));
    const response = await fetch(target.pathname + target.search, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      redirect: 'error', headers: { Accept: 'application/octet-stream' }, signal: chunkSignal,
    });
    return consume(response);
  } });
}

export function deadlineText(value) {
  if (!value) return 'No deadline set';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Deadline unavailable';
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

export function assignmentRestriction(assignment) {
  if (!['none','cleared'].includes(assignment.conflict)) return `Assessment access is restricted by the conflict status: ${assignment.conflict || 'unavailable'}. Contact the awards administrator.`;
  if (assignment.state !== 'assigned') return `This assignment is ${assignment.state || 'unavailable'} and cannot be assessed.`;
  if (assignment.eligibility !== 'eligible') return `This application is ${assignment.eligibility || 'unavailable'} and cannot be assessed.`;
  if (assignment.included === false) return 'This assignment is excluded from assessment.';
  return '';
}
