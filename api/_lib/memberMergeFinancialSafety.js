import { checkMemberDeletionBilling } from './memberDeletionBillingSafety.js';
import { selectCurrentMemberMandate } from './memberGocardlessMandate.js';
import { shapeLegacyCurrentMembership, shapePersistedCommitment } from '../membership/member-membership.js';

// All reads are local persisted evidence. Never contact or mutate a provider.
async function complete(query) {
  const { data, error, count } = await query;
  if (error || !Array.isArray(data) || (count != null && count > data.length)) {
    throw new Error('Financial evidence could not be completely verified');
  }
  return data;
}

export async function readMemberMandates(db, { tenantId, memberId }) {
  const agreements = await complete(db.from('membership_billing_agreements')
    .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
    .eq('member_id', memberId).eq('agreement_type', 'member').is('organization_id', null));
  const plans = await complete(db.from('membership_payment_plans')
    .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
    .eq('member_id', memberId).is('organization_id', null));
  for (let offset = 0; offset < agreements.length; offset += 100) {
    plans.push(...await complete(db.from('membership_payment_plans')
      .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
      .in('billing_agreement_id', agreements.slice(offset, offset + 100).map(row => row.id))
      .is('organization_id', null)));
  }
  const ids = [...new Set([...agreements, ...plans].map(row => row.gocardless_mandate_id).filter(Boolean))];
  const mandates = [];
  // A reusable mandate can be linked only through the member's customer,
  // including after the setup journey was abandoned or its agreement expired.
  const customers = await complete(db.from('gocardless_customers')
    .select('gocardless_customer_id', { count: 'exact' }).eq('tenant_id', tenantId)
    .eq('member_id', memberId).is('organization_id', null));
  if (customers.some(row => !row.gocardless_customer_id)) {
    throw new Error('Member Direct Debit customer link is incomplete');
  }
  const customerIds = [...new Set(customers.map(row => row.gocardless_customer_id))];
  for (let offset = 0; offset < customerIds.length; offset += 100) {
    const linked = await complete(db.from('gocardless_mandates')
      .select('tenant_id,gocardless_mandate_id,status', { count: 'exact' })
      .eq('tenant_id', tenantId).in('gocardless_customer_id', customerIds.slice(offset, offset + 100)));
    if (linked.some(row => !row.gocardless_mandate_id)) {
      throw new Error('Member Direct Debit mandate link is incomplete');
    }
    mandates.push(...linked);
    for (const row of linked) {
      if (!ids.includes(row.gocardless_mandate_id)) ids.push(row.gocardless_mandate_id);
    }
  }
  for (let offset = 0; offset < ids.length; offset += 100) {
    mandates.push(...await complete(db.from('gocardless_mandates')
      .select('tenant_id,gocardless_mandate_id,status', { count: 'exact' })
      .eq('tenant_id', tenantId).in('gocardless_mandate_id', ids.slice(offset, offset + 100))));
  }
  const statuses = ids.flatMap(id => {
    const matches = mandates.filter(row => row.tenant_id === tenantId && row.gocardless_mandate_id === id);
    return matches.length ? matches.map(row => row.status) : [null];
  });
  const known = new Set(['pending_customer_approval', 'pending_submission', 'submitted', 'active',
    'failed', 'cancelled', 'expired', 'consumed', 'blocked', 'created']);
  return {
    current: selectCurrentMemberMandate({ memberId, agreements, plans, mandates }),
    active: statuses.includes('active'),
    verified: statuses.every(status => known.has(status)),
    statuses: [...new Set(statuses.filter(Boolean))],
  };
}

export function activePaidMembership(history, tenantId, now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return history.some(record => {
    if (shapeLegacyCurrentMembership({ ...record, membership_source: 'personal' }, tenantId, now)) return true;
    if (!['active', 'paid'].includes(record.status)
        || !['paid', 'partial'].includes(record.payment_status)) return false;
    const commitment = shapePersistedCommitment(record, now);
    const start = commitment?.startDate || record.term_start_date;
    const end = commitment?.endDate || record.term_end_date;
    return validDate(start) && validDate(end) && start <= today && today <= end
      && (!commitment || !['scheduled', 'past'].includes(commitment.lifecycle));
  });
}

export async function readMergeFinancialSummary(db, { tenantId, memberId }) {
  const [membership, directDebit] = await Promise.all([
    complete(db.from('member_membership_history').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('member_id', memberId))
      .then(rows => ({ state: activePaidMembership(rows, tenantId) ? 'active_paid' : 'none' }))
      .catch(() => ({ state: 'unknown' })),
    readMemberMandates(db, { tenantId, memberId })
      .catch(() => ({ verified: false, active: false, statuses: [] })),
  ]);
  return { membership, directDebit };
}

export async function checkMergeSourceDisposal(db, { source, target, tenantId, directDebit }) {
  const billing = await checkMemberDeletionBilling(db, { memberId: source.id, tenantId });
  const dd = directDebit || await readMemberMandates(db, { tenantId, memberId: source.id })
    .catch(() => ({ verified: false }));
  const name = `${source.first_name || ''} ${source.last_name || ''}`.trim() || source.email || source.id;
  const sourceEmail = String(source.email || '').trim().toLowerCase();
  const targetEmail = String(target.email || '').trim().toLowerCase();
  let reason = null;
  if (!dd.verified || !sourceEmail || !targetEmail) {
    reason = 'Email or Direct Debit verification is incomplete. Refresh the preview after resolving the missing evidence.';
  } else if (dd.active && sourceEmail !== targetEmail) {
    reason = 'This record has an active GoCardless mandate and its saved email differs from the surviving record. Copying its email does not make removal safe.';
  }
  const success = !reason && billing.success;
  return { ...billing, success,
    status: reason ? (!dd.verified || !sourceEmail || !targetEmail ? 503 : 409) : billing.status,
    error: success ? null : `${name} cannot be removed or anonymised. ${reason || ''} ${billing.error || ''}`.trim(),
  };
}
