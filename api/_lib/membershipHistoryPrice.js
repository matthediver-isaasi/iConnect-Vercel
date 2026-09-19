import { loadGoCardlessCollectionDetails } from './gocardlessCollectionDetails.js';
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

const DIRECT_DEBIT_METHODS = new Set(['direct_debit', 'gocardless']);
const ONGOING_STATUSES = new Set(['active', 'mandate_pending', 'first_payment_pending']);
const MAX_HISTORY_PRICE_ROWS = 20;

function sourceOf(row) {
  return row?.membership_source === 'organisation' ? 'organisation' : 'personal';
}

function ownerMatches(record, candidate) {
  if (!record || !candidate || record.tenant_id !== candidate.tenant_id) return false;
  if (sourceOf(record) === 'organisation') {
    return !!record.organization_id
      && candidate.organization_id === record.organization_id
      && !candidate.member_id;
  }
  return !!record.member_id
    && candidate.member_id === record.member_id
    && !candidate.organization_id;
}

function planMatches(record, agreement, plan) {
  return !!plan
    && plan.tenant_id === record.tenant_id
    && plan.billing_agreement_id === agreement.id
    && ownerMatches(record, plan);
}

function validFutureDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    && value >= today
    ? value
    : null;
}

function unavailable(currency = null) {
  return { state: 'unavailable', amount: null, currency: currency || null, date: null };
}

function rowDeclaresDynamic(record) {
  const snapshot = record?.commitment_snapshot;
  return snapshot && typeof snapshot === 'object'
    && resolveSavedCollectionPolicy(snapshot).pricing_policy === 'dynamic';
}

/**
 * Add a current monthly price to authorized history rows without changing
 * their persisted totals. Every provider read is reached only through the
 * row's tenant/owner-validated agreement and latest matching plan.
 */
export async function enrichMembershipHistoryPrices(records, {
  db,
  tenantId,
  now = new Date(),
  loadDetails = loadGoCardlessCollectionDetails,
} = {}) {
  if (!Array.isArray(records) || !db || !tenantId) return records;
  const today = new Date(now).toISOString().slice(0, 10);
  const eligibleRows = records.filter((row) => row?.tenant_id === tenantId
      && row?.billing_agreement_id
      && DIRECT_DEBIT_METHODS.has(row.payment_method));
  for (const record of eligibleRows.filter(rowDeclaresDynamic)) {
    record.monthly_price = unavailable(
      record.commitment_snapshot?.amounts?.currency || record.currency,
    );
  }
  const candidates = eligibleRows.slice(0, MAX_HISTORY_PRICE_ROWS);

  for (const record of candidates) {
    const snapshotCurrency = record.commitment_snapshot?.amounts?.currency || record.currency || null;
    try {
      const agreementResult = await db.from('membership_billing_agreements')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('id', record.billing_agreement_id)
        .maybeSingle();
      const agreement = agreementResult.data;
      if (agreementResult.error || !ownerMatches(record, agreement)
          || agreement.provider !== 'gocardless') continue;

      const terms = agreement.metadata?.dd || {};
      if (resolveSavedCollectionPolicy(terms).pricing_policy !== 'dynamic') continue;
      record.monthly_price = unavailable(terms.currency || snapshotCurrency);
      if (!ONGOING_STATUSES.has(agreement.status)) continue;

      const planResult = await db.from('membership_payment_plans')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('billing_agreement_id', agreement.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      const plan = planResult.data;
      if (planResult.error || !planMatches(record, agreement, plan)
          || !ONGOING_STATUSES.has(plan.status) || plan.collection_stopped_at) continue;

      const details = await loadDetails({
        db, tenantId, agreement, plan, now,
      });
      const providerDate = validFutureDate(details?.upcomingCollection?.dueDate, today);
      if (providerDate && Number.isFinite(details.upcomingCollection?.amount)) {
        record.monthly_price = {
          state: 'provider_scheduled',
          amount: details.upcomingCollection.amount,
          currency: details.upcomingCollection.currency || details.currency || terms.currency || null,
          date: providerDate,
        };
        continue;
      }

      // A reservation amount is deliberately insufficient. The loader labels
      // only a newly resolved active-structure result as a current calculation.
      const previewDate = validFutureDate(details?.pricePreview?.dueDate, today);
      if (previewDate
          && details?.pricePreview?.label === 'Current calculated price — not a confirmed charge'
          && Number.isFinite(details.pricePreview.amount)) {
        record.monthly_price = {
          state: 'calculated',
          amount: details.pricePreview.amount,
          currency: details.pricePreview.currency || details.currency || terms.currency || null,
          date: previewDate,
        };
      }
    } catch {
      // Applicable dynamic rows retain the explicit unavailable shape set
      // above. Read failures never fall back to an old quote.
    }
  }
  return records;
}

export default enrichMembershipHistoryPrices;