import { createHash } from 'node:crypto';
import { loadStripeCollectionSchedule } from './membershipCollectionSchedule.js';
import { getGocardlessCredentials } from './gocardlessCredentials.js';
import { createGocardlessClient } from './gocardless.js';
import { getStripeIntegrationCredentials } from './stripeCredentials.js';
import { projectMembershipPaymentReport } from './membershipPaymentReport.js';

const unavailable = () => ({ nextConfirmedDate: null, evidence: 'unavailable' });

export async function readPaymentReportSchedule(request, deps = {}) {
  const { tenantId, agreement, plan, today } = request;
  if (!agreement || !plan || agreement.tenant_id !== tenantId || plan.tenant_id !== tenantId
    || plan.billing_agreement_id !== agreement.id || !agreement.member_id
    || plan.member_id !== agreement.member_id || agreement.organization_id || plan.organization_id
    || plan.provider !== agreement.provider || plan.environment !== agreement.environment
    || !['active', 'mandate_pending', 'first_payment_pending'].includes(plan.status)
    || !['active', 'mandate_pending', 'first_payment_pending'].includes(agreement.status)
    || plan.collection_stopped_at) return unavailable();
  if (agreement.provider === 'stripe') {
    return (deps.loadStripe || loadStripeCollectionSchedule)({
      tenantId, agreement, plan, now: new Date(`${today}T00:00:00.000Z`),
      getCredentials: async id => {
        const credentials = await (deps.getStripeCredentials || getStripeIntegrationCredentials)(id);
        return credentials?.is_enabled === false ? null : credentials;
      },
    });
  }
  if (agreement.provider !== 'gocardless' || !plan.gocardless_subscription_id) return unavailable();
  const credentials = await (deps.getGcCredentials || getGocardlessCredentials)(tenantId);
  // Never allow gocardlessForTenant's platform fallback or a different mode.
  if (credentials?.source !== 'tenant' || credentials.tenantId !== tenantId
    || credentials.environment !== agreement.environment || !credentials.accessToken
    || !['sandbox', 'live'].includes(credentials.environment)
    || plan.environment !== agreement.environment || !agreement.gocardless_mandate_id
    || (plan.gocardless_mandate_id && plan.gocardless_mandate_id !== agreement.gocardless_mandate_id)) return unavailable();
  const client = (deps.createGcClient || createGocardlessClient)(credentials);
  const subscription = await client.getSubscription(plan.gocardless_subscription_id);
  if (subscription?.id !== plan.gocardless_subscription_id
    || subscription.links?.mandate !== agreement.gocardless_mandate_id) return unavailable();
  if (['cancelled', 'finished', 'completed'].includes(subscription.status)) {
    return { nextConfirmedDate: null, evidence: 'provider_subscription' };
  }
  if (subscription.status !== 'active') return unavailable();
  const dates = (subscription.upcoming_payments || []).map(payment => payment.charge_date)
    .filter(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today).sort();
  return { nextConfirmedDate: dates[0] || null, evidence: 'provider_subscription' };
}

/**
 * Process-wide bounded read cache: max 500 entries, 4 concurrent provider reads,
 * 60 new reads/minute, 30 new reads/report and 8 seconds/report. Limits apply
 * across tenants; keys isolate tenants, owners, environment and lifecycle.
 * Timed-out reads keep their concurrency slot until the provider settles.
 */
export function createReportScheduleResolver({
  load = readPaymentReportSchedule, maxCalls = 30, concurrency = 4, budgetMs = 8000,
  maxPerMinute = 60, ttlMs = 60000, maxEntries = 500, clock = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let windowStart = clock();
  let windowCalls = 0;
  return async function resolve(input) {
    const requests = new Map();
    const today = input.today || new Date().toISOString().slice(0, 10);
    projectMembershipPaymentReport({ ...input, today, collectScheduleRequest: request => requests.set(request.plan.id, request) });
    const results = new Map();
    const deadline = clock() + budgetMs;
    let calls = 0;
    const entries = [...requests.values()].sort((a, b) => a.plan.id.localeCompare(b.plan.id));
    let cursor = 0;
    async function worker() {
      while (cursor < entries.length) {
        const request = entries[cursor++];
        const key = createHash('sha256').update(JSON.stringify([
          request.tenantId, request.today, request.member.id, request.member.membership_paused,
          request.record, request.agreement, request.plan,
        ])).digest('hex');
        const cached = cache.get(key);
        if (cached && cached.expires > clock()) {
          results.set(request.plan.id, cached.value);
          continue;
        }
        cache.delete(key);
        if (clock() - windowStart >= 60000) { windowStart = clock(); windowCalls = 0; }
        let job = pending.get(key);
        if (!job && calls < maxCalls && windowCalls < maxPerMinute
          && pending.size < concurrency && clock() < deadline) {
          calls++; windowCalls++;
          job = Promise.resolve().then(() => load(request)).catch(() => unavailable()).then(value => {
            const safe = { nextConfirmedDate: value?.nextConfirmedDate || null, evidence: value?.evidence || 'unavailable' };
            cache.set(key, { value: safe, expires: clock() + (safe.evidence === 'unavailable' ? 10000 : ttlMs) });
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
            return safe;
          }).finally(() => pending.delete(key));
          pending.set(key, job);
        }
        if (!job || clock() >= deadline) { results.set(request.plan.id, unavailable()); continue; }
        let timer;
        const value = await Promise.race([job, new Promise(resolve =>
          { timer = setTimeout(() => resolve(unavailable()), Math.max(0, deadline - clock())); })]);
        clearTimeout(timer);
        results.set(request.plan.id, value);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  };
}

export const resolvePaymentReportSchedules = createReportScheduleResolver();