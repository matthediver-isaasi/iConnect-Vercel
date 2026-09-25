import { loadDirectDebitMembershipPresentations } from './directDebitMembershipPresentation.js';
import { resolveDynamicCollectionPrice } from './directDebitDynamicPipeline.js';

const inactive = new Set(['paused', 'cancelled', 'canceled', 'completed', 'expired', 'suspended', 'restricted', 'failed', 'payment_plan_cancelled']);
const amount = (minor, currency) => Number.isSafeInteger(minor) && minor >= 0 && /^[A-Z]{3}$/.test(currency || '')
  ? { nextPaymentAmount: minor / 100, nextPaymentCurrency: currency } : {};
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// READ ONLY: share the console's entitlement authority and the collector's
// pricing resolver, never its orchestration/reservation/submission functions.
export async function loadPaymentReportDirectDebit(input, { db,
  loadPresentations = loadDirectDebitMembershipPresentations,
  resolvePrice = resolveDynamicCollectionPrice,
} = {}) {
  const { tenantId, members, agreements, plans, payments, reservations = [], today = new Date().toISOString().slice(0, 10) } = input;
  const eligible = plans.filter(plan => {
    const agreement = agreements.find(a => a.id === plan.billing_agreement_id);
    return plan.tenant_id === tenantId && plan.provider === 'gocardless' && !plan.organization_id
      && members.some(m => m.id === plan.member_id && m.tenant_id === tenantId)
      && agreement?.tenant_id === tenantId && agreement.member_id === plan.member_id && !agreement.organization_id
      && agreement.provider === plan.provider && agreement.environment === plan.environment
      && ['live', 'sandbox'].includes(plan.environment)
      && agreement.gocardless_mandate_id && (!plan.gocardless_mandate_id || plan.gocardless_mandate_id === agreement.gocardless_mandate_id);
  });
  const presentations = await loadPresentations(db, tenantId, eligible, today);
  const result = new Map();
  async function enrich(plan) {
    const agreement = agreements.find(a => a.id === plan.billing_agreement_id);
    const member = members.find(m => m.id === plan.member_id);
    const held = !!plan.collection_stopped_at || plan.metadata?.bnms_release_required === true;
    const stopped = member.membership_paused || inactive.has(plan.status) || inactive.has(agreement.status);
    const detail = {
      status: member.membership_paused ? 'paused' : presentations.get(plan.id)?.displayStatus || plan.status,
      nextPaymentAmount: null, nextPaymentCurrency: null,
      collectionDate: null, collectionBasis: stopped ? 'not_scheduled' : held ? 'held' : 'unavailable',
      nextPaymentAmountState: stopped ? 'Not scheduled' : 'Review required — next amount unavailable',
      nextStructureName: null, nextStructureState: 'Review required — collection structure unavailable',
      ...(held ? { paymentArrangement: 'Collection held — not scheduled' } : {}),
    };
    if (detail.status === 'first_payment_pending') detail.statusLabel = 'Awaiting first payment';
    if (detail.status === 'membership_unverified') detail.statusLabel = 'Membership status unverified';
    result.set(plan.id, detail);
    if (stopped) {
      detail.nextStructureState = 'Not scheduled';
      return;
    }
    const pending = payments.filter(p => p.tenant_id === tenantId && p.plan_id === plan.id
      && p.environment === plan.environment && p.gocardless_payment_id
      && p.gocardless_mandate_id === agreement.gocardless_mandate_id
      && (!p.billing_agreement_id || p.billing_agreement_id === agreement.id)
      && (!plan.gocardless_subscription_id || p.gocardless_subscription_id === plan.gocardless_subscription_id)
      && ['pending_submission', 'submitted'].includes(p.status) && validDay(p.charge_date) && p.charge_date >= today)
      .sort((a, b) => a.charge_date.localeCompare(b.charge_date));
    const next = pending[0];
    if (next && pending.filter(p => p.charge_date === next.charge_date).length > 1) {
      detail.nextPaymentAmountState = 'Review required — multiple next collections';
      return;
    }
    if (next) {
      Object.assign(detail, amount(next.amount_minor, next.currency));
      if (detail.nextPaymentAmount !== null) {
        detail.nextPaymentAmountState = 'Provider-scheduled payment';
        detail.collectionDate = next.charge_date;
        detail.collectionBasis = 'confirmed';
      }
    }
    if (plan.metadata?.collection_mode === 'dynamic') {
      if (next) {
        // Once submitted, immutable reservation pricing wins over edited config.
        const saved = reservations.filter(r => r.tenant_id === tenantId && r.plan_id === plan.id
          && r.billing_agreement_id === agreement.id
          && r.gocardless_payment_id === next.gocardless_payment_id);
        if (saved.length === 1 && saved[0].price_snapshot?.config?.name) {
          detail.nextStructureName = saved[0].price_snapshot.config.name;
          detail.nextStructureState = 'Submitted collection structure';
        }
        return;
      }
      const date = plan.dynamic_next_collection_date;
      if (!validDay(date) || date < today) {
        detail.nextPaymentAmountState = 'Review required — planned collection date missing or overdue';
        return;
      }
      try {
        const price = await resolvePrice(agreement, date, { db,
          configRows: input.configs, bandRows: input.bands, vatRows: input.vatRules });
        Object.assign(detail, amount(price.monthly_amount_minor, price.currency), {
          collectionDate: held ? null : date, collectionBasis: held ? 'held' : 'projected',
          nextPaymentAmountState: held ? 'Configured amount — collection held' : 'Projected collection amount — not yet bank scheduled',
          nextStructureName: price.config?.name || null,
          nextStructureState: price.config?.name ? 'Structure effective on planned collection date' : 'Review required — structure name missing',
        });
        if (detail.nextPaymentAmount === null) {
          detail.collectionDate = null;
          detail.collectionBasis = 'unavailable';
          detail.nextPaymentAmountState = 'Review required — amount or currency invalid';
        }
      } catch {
        detail.nextPaymentAmountState = 'Review required — collection pricing could not be resolved';
      }
    } else {
      if (!next) {
        Object.assign(detail, amount(plan.amount_minor, plan.currency));
        if (detail.nextPaymentAmount !== null) detail.nextPaymentAmountState = held
          ? 'Configured amount — collection held' : 'Configured plan amount — bank schedule unverified';
      }
      const config = agreement.metadata?.dd?.commitment?.commitment_snapshot?.config;
      if (config?.name) {
        detail.nextStructureName = config.name;
        detail.nextStructureState = 'Agreed plan structure';
      }
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (cursor < eligible.length) await enrich(eligible[cursor++]);
  }));
  return result;
}