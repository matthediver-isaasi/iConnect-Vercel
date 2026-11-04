import { createHash } from 'node:crypto';
import { accountingRetryAfterSeconds } from './accountingRequestQueue.js';

export const XERO_LIMIT_HEADERS = [
  'retry-after', 'x-daylimit-remaining', 'x-minlimit-remaining',
  'x-appminlimit-remaining', 'x-rate-limit-problem',
];

const unavailable = () => Object.assign(new Error('XERO_RATE_COORDINATION_UNAVAILABLE'), {
  code: 'XERO_RATE_COORDINATION_UNAVAILABLE', retry: true, definitelyNotWritten: true,
});

async function resolveIdentity(headers) {
  const [{ supabase }, { getXeroCredentials }] = await Promise.all([
    import('./database.js'), import('./xeroCredentials.js'),
  ]);
  const companyId = headers.get('xero-tenant-id');
  const bearer = headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!supabase || !companyId || !bearer || companyId === 'PENDING_SELECTION') throw unavailable();
  // Never infer app identity from the organisation alone. No tokens are retained
  // in the quota tables or logs. Ambiguous/unowned legacy grants fail closed.
  const { data, error } = await supabase.from('xero_token').select('app_tenant_id')
    .eq('tenant_id', companyId).eq('access_token', bearer).limit(2)
    .abortSignal(AbortSignal.timeout(5000));
  if (error || data?.length !== 1 || !data[0].app_tenant_id) throw unavailable();
  const credentials = await getXeroCredentials(data[0].app_tenant_id, { signal: AbortSignal.timeout(5000) });
  if (!credentials?.is_enabled || !credentials.client_id) throw unavailable();
  return { db: supabase, appKey: createHash('sha256').update(credentials.client_id.trim().toLowerCase()).digest('hex'), companyId };
}

async function rpc(db, name, args) {
  const query = db.rpc(`xero_rate_${name}`, args);
  const { data, error } = await (query.abortSignal ? query.abortSignal(AbortSignal.timeout(5000)) : query);
  if (error) throw unavailable();
  return data;
}

/**
 * One attempt only: reserve before HTTP, publish headers before releasing.
 * OAuth/token and /connections have no Accounting API organisation quota.
 * Inject the identity/transport for isolated tests, never a process-local limiter.
 */
export function createXeroRateLimitedFetch({ resolve = resolveIdentity, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return async function xeroFetch(url, init = {}) {
    const parsed = new URL(url instanceof Request ? url.url : url, 'http://relative.invalid');
    if (parsed.origin !== 'https://api.xero.com' || !parsed.pathname.startsWith('/api.xro/')) {
      return fetchImpl(url, init);
    }
    const headers = new Headers(init.headers || (url instanceof Request ? url.headers : undefined));
    const { db, appKey, companyId } = await resolve(headers);
    const args = { p_app: appKey, p_company: companyId };
    const reservation = await rpc(db, 'reserve', args);
    if (!reservation?.id) {
      // Use a normal HTTP rejection so legacy callers and queued adapters keep
      // their existing 429 handling. No financial request has been sent.
      return new Response(JSON.stringify({ ErrorNumber: 429, Message: 'Shared Xero rate-limit pause' }), {
        status: 429, headers: { 'content-type': 'application/json',
          'retry-after': String(reservation?.retry_after || 60), ...(reservation?.headers || {}) },
      });
    }
    let response;
    let evidence = {};
    try {
      init.signal?.throwIfAborted();
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      response = await fetchImpl(url, { ...init, signal, redirect: 'error' });
      evidence = Object.fromEntries(XERO_LIMIT_HEADERS.map(key => [key, response.headers.get(key)])
        .filter(([, value]) => value !== null));
      // Consume the body while holding the concurrent-request lease. Returning
      // a buffered response also prevents unbounded PDF/download transports.
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, headers: response.headers });
    } finally {
      try {
        await rpc(db, 'finish', { ...args, p_id: reservation.id,
          p_status: response?.status || 0, p_headers: evidence,
          p_retry: evidence['retry-after'] ? accountingRetryAfterSeconds(evidence['retry-after']) : null });
      } catch {
        // A persistence failure after sending MUST NOT certify no write.
        throw Object.assign(new Error('XERO_RATE_RESULT_PERSISTENCE_FAILED'), {
          code: 'XERO_RATE_RESULT_PERSISTENCE_FAILED', retry: true,
          definitelyNotWritten: false, ambiguous: true,
        });
      }
    }
  };
}

export const xeroRateLimitedFetch = createXeroRateLimitedFetch();
