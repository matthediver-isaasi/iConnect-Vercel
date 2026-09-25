import { loadPaymentReportDirectDebit } from './membershipPaymentReportDirectDebit.js';

// Member-scoped, read-only adapter. Reuse report/collector price selection, not
// the report's tenant-wide entitlement loader. Canvas already resolved this
// member's recognised entitlement from the self-owned history and recognition.
export async function canvasDirectDebitCollection(db, { tenantId, owner, plan, summary, today }) {
  if (plan?.provider !== 'gocardless' || plan.metadata?.collection_mode !== 'dynamic') return summary;
  if (['cancelled', 'canceled', 'expired', 'failed'].includes(plan.migratedMandateStatus)) {
    return { ...summary, payment: {
      ...summary.payment,
      state: plan.migratedMandateStatus === 'expired' ? 'expired'
        : plan.migratedMandateStatus === 'failed' ? 'failed' : 'paused',
      amount: null, currency: null, nextPayment: null, plannedPayment: null, nextCollection: null,
      confirmedPayment: null, collectionStatus: 'unavailable', collectionBasis: 'unavailable',
      collectionNotice: 'Direct Debit mandate is not active — collection details require review',
      collectionStructure: null, structureNotice: 'Review required — collection structure unavailable',
    } };
  }
  const agreement = plan.membership_billing_agreements;
  const read = async (table, columns) => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(table).select(columns)
        .eq('tenant_id', tenantId).eq('plan_id', plan.id)
        .order('id', { ascending: true }).range(offset, offset + 499);
      if (error) throw error;
      if (!Array.isArray(data) || data.some(row => row.tenant_id !== tenantId || row.plan_id !== plan.id)) {
        throw new Error('Collection evidence ownership mismatch');
      }
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  };
  const payments = await read('gocardless_payments',
    'id,tenant_id,plan_id,environment,gocardless_payment_id,gocardless_mandate_id,gocardless_subscription_id,status,charge_date,amount_minor,currency');
  const reservations = payments.some(p => ['pending_submission', 'submitted'].includes(p.status) && p.charge_date >= today)
    ? await read('gocardless_collection_reservations',
      'id,tenant_id,plan_id,billing_agreement_id,gocardless_payment_id,price_snapshot') : [];
  const details = await loadPaymentReportDirectDebit({
    tenantId, members: [owner], agreements: [agreement], plans: [plan], payments, reservations, today,
  }, { db, loadPresentations: async () => new Map() });
  const detail = details.get(plan.id);
  const basis = detail?.collectionBasis || 'unavailable';
  const held = !!plan.collection_stopped_at || plan.metadata?.bnms_release_required === true;
  const date = detail?.collectionDate || null;
  const next = date && ['projected', 'confirmed'].includes(basis) ? {
    date, amount: detail.nextPaymentAmount, currency: detail.nextPaymentCurrency,
    status: basis === 'projected' ? 'planned' : 'confirmed',
  } : null;
  const state = owner.membership_paused || held ? 'paused'
    : summary.membership.state === 'active' && ['active', 'pending', 'first_payment_pending'].includes(summary.payment.state)
      ? 'current_direct_debit' : summary.payment.state;
  return {
    ...summary,
    payment: {
      ...summary.payment, state,
      amount: detail?.nextPaymentAmount ?? null,
      currency: detail?.nextPaymentCurrency ?? null,
      nextPayment: next?.date || null, nextCollection: next,
      plannedPayment: next?.status === 'planned' ? { date: next.date, amount: next.amount, currency: next.currency } : null,
      // No local initial collection is confirmation of settlement. Historical
      // imported payments are not a scheduled payment or this term's invoice.
      confirmedPayment: null,
      collectionStatus: next?.status || (basis === 'unavailable' ? 'unavailable' : 'unscheduled'),
      collectionBasis: basis,
      collectionNotice: detail?.nextPaymentAmountState || 'Review required — collection evidence could not be matched',
      collectionStructure: detail?.nextStructureName || null,
      structureNotice: detail?.nextStructureState || 'Review required — collection structure unavailable',
    },
  };
}