import { resolveMemberDateTerm } from './memberDateTermPolicy.js';

export async function simulateMemberDateTerm(db, { tenantId, member, config, options, today }) {
  try {
    if (options.source !== 'form-payment' || options.memberDateAuthorized !== true) {
      throw new Error('This schedule requires the member to complete their membership form. It cannot renew automatically.');
    }
    if (config.is_active !== true || (config.effective_from && config.effective_from > today)
        || (config.effective_to && config.effective_to < today)) throw new Error('This membership schedule is not currently available.');
    const owner = await db.from('member').select('id,membership_paused')
      .eq('tenant_id', tenantId).eq('id', member.id).maybeSingle();
    if (owner.error || !owner.data) throw new Error('Membership eligibility could not be verified.');
    if (owner.data.membership_paused) throw new Error('Your membership is paused. Please contact the membership team.');
    const pending = await db.from('membership_billing_agreements').select('id,status')
      .eq('tenant_id', tenantId).eq('member_id', member.id)
      .in('status', ['active', 'pending', 'pending_setup', 'past_due']);
    if (pending.error) throw new Error('Could not check existing payment arrangements.');
    if (pending.data?.length) throw new Error('An existing payment arrangement needs review before starting a no-charge membership.');
    const result = await db.from('member_membership_history').select('*')
      .eq('tenant_id', tenantId).eq('member_id', member.id);
    if (result.error) throw new Error('Could not verify existing membership terms.');
    const live = (result.data || []).filter(h => !['expired_checkout', 'voided', 'cancelled'].includes(h.status)
      && !['voided', 'cancelled'].includes(h.payment_status));
    if (live.some(h => !h.term_start_date || !h.term_end_date)) {
      throw new Error('Existing membership dates need review before creating a new term.');
    }
    const current = live.filter(h => h.term_end_date >= today);
    let existing = null;
    if (current.length) {
      if (current.length !== 1 || current[0].config_id !== config.id
          || current[0].term_source_snapshot?.type !== 'member_date_field' || current[0].payment_status !== 'paid') {
        throw new Error('A current or pending membership already exists. Ask the membership team about changing it.');
      }
      existing = current[0];
    }
    const term = await resolveMemberDateTerm(db, { tenantId, memberId: member.id, config,
      startDate: existing?.term_start_date || today, fieldOverrides: options.fieldOverrides });
    if (existing && term.term_end_date !== existing.term_end_date) {
      throw new Error('Changing this membership end date requires an administrator to record a manual extension.');
    }
    const savedTerm = existing ? {
      term_start_date: existing.term_start_date, term_end_date: existing.term_end_date,
      membership_renewal_date: existing.membership_renewal_date,
      term_source_snapshot: existing.term_source_snapshot, term_duration_months: null,
    } : term;
    return {
      success: true, member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim(), email: member.email },
      config, memberDateTerm: true, paymentSchedule: savedTerm,
      membershipYear: { label: existing?.membership_year || `member-date:${term.term_start_date}:${term.term_end_date}`,
        start: savedTerm.term_start_date, end: savedTerm.term_end_date },
      tierLabel: config.name, annualCost: 0, finalCost: 0, vatAmount: 0, totalWithVat: 0,
      currency: config.currency || 'GBP', billingPeriod: config.billing_period || 'annual',
      existingRecord: existing, steps: [], matchedBand: null, invoicePreview: null,
    };
  } catch (error) {
    return { success: false, code: 'MEMBER_DATE_TERM_REVIEW', error: error.message, steps: [] };
  }
}
