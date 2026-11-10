import { createHash } from 'node:crypto';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
const terminal = x => ['cancelled', 'canceled', 'expired', 'completed', 'failed', 'payment_plan_cancelled'].includes(x.status);
export function invoiceKind(invoice) {
  if (invoice.record_kind !== 'invoice') return null;
  const text = invoice.description || '';
  if (/^(?:full|junior|trainee|associate|retired|student|lmic|overseas)\b.*\bmembership\b/i.test(text)
      && !/[|]/.test(text) && !/months?|days?|event|course|conference/i.test(text)) return 'standalone';
  if (/(?:1|one)\s*year.?s?.{0,35}membership/i.test(text)) return 'included_with_event';
  return null;
}
export function reviewMember(member, histories, invoices, configs, preferences, related, today) {
  const hold = reason => ({ memberId: member.id, state: 'held', reason, repairs: [] });
  if (member.tenant_id !== TENANT || member.is_deleted) return hold('Deleted or wrong-tenant member');
  if (member.membership_paused || member.membership_cancelled) return hold('Membership paused or cancelled');
  if (related.agreements.some(a => !terminal(a)) || related.plans.some(p => !terminal(p))) return hold('Existing payment arrangement requires separate review');
  if (related.quotes.length || related.elections.length) return hold('Existing checkout or successor evidence requires separate review');
  const cls = preferences.memberClass;
  const repairs = [];
  for (const h of histories) {
    if (h.term_start_date && (h.commitment_snapshot?.config || h.renewal_policy_snapshot)) continue;
    if (h.tenant_id !== TENANT || h.payment_status !== 'paid' || h.term_key || h.billing_agreement_id
        || h.membership_payment_quote_id || h.membership_successor_election_id
        || !['upfront', null].includes(h.payment_method)
        || !['active', 'expired'].includes(h.status)) return hold('History has financial/recurring authority or is not a settled legacy term');
    const end = day(h.term_end_date);
    if (!end) return hold('No retained expiry to preserve');
    const matches = invoices.filter(i => i.tenant_id === TENANT && i.member_id === member.id
      && invoiceKind(i) && i.accounting_payment_status === 'paid' && i.accounting_status === 'PAID'
      && i.xero_document_id && day(i.invoice_date)
      && (Date.parse(end) - Date.parse(day(i.invoice_date))) / 86400000 >= 300
      && (Date.parse(end) - Date.parse(day(i.invoice_date))) / 86400000 <= 430
      && (!(h.accounting_invoice_id || h.xero_invoice_id) || (h.accounting_invoice_id || h.xero_invoice_id) === i.xero_document_id));
    if (matches.length !== 1) return hold(matches.length ? 'Multiple membership invoices fit the retained term' : 'No unique paid membership invoice in the retained annual period');
    const invoice = matches[0], kind = invoiceKind(invoice);
    if (invoices.some(i => i.xero_document_id === invoice.xero_document_id
        && i.accounting_payment_status && i.accounting_payment_status !== 'paid')) return hold('Conflicting invoice payment evidence');
    const matched = configs.filter(c => c.tenant_id === TENANT && c.structure_scope_type === 'member'
      && c.is_active && c.structure_match_value === cls && c.effective_from <= today
      && (!c.effective_to || c.effective_to >= today));
    if (matched.length !== 1) return hold('No unique current schedule for the retained member class');
    const config = matched[0];
    if (h.config_id && h.config_id !== config.id) return hold('Saved schedule differs from current member-class schedule');
    if (config.billing_period !== 'annual' || !Number.isInteger(config.renewal_open_days)
      || !Number.isInteger(config.renewal_grace_days)) return hold('Annual renewal policy unavailable');
    const start = day(h.term_start_date) || day(invoice.invoice_date);
    if (histories.some(other => other.id !== h.id && other.term_start_date
      && day(other.term_start_date) <= end && day(other.term_end_date) >= start)) return hold('Overlapping retained membership terms');
    const policy = { id: config.id, tenant_id: TENANT, name: config.name,
      renewal_open_days: config.renewal_open_days, renewal_grace_days: config.renewal_grace_days,
      renewal_change_role: config.renewal_change_role, renewal_disable_login: config.renewal_disable_login,
      renewal_fallback_role_id: config.renewal_fallback_role_id,
      authority: 'owner_approved_current_schedule_for_reconstructed_renewal_not_historical_purchase' };
    const authority = { version: 1, source: 'bnms_owner_approved_invoice_date_reconstruction',
      approvedOn: '2026-11-11', originalNotes: h.notes, invoiceEvidenceId: invoice.id,
      invoiceNumber: invoice.invoice_number, invoiceDate: day(invoice.invoice_date),
      startAuthority: h.term_start_date ? 'retained_previously_recorded_start' : 'owner_approved_invoice_date',
      expiryAuthority: 'retained_expiry_unchanged', paymentAuthority: 'retained_paid_history_and_stored_paid_invoice',
      liveProviderVerified: false, bundledMembership: kind === 'included_with_event',
      amountAuthority: kind === 'included_with_event' ? 'bundled_invoice_not_allocated_to_membership' : 'retained_membership_amounts',
      renewalPolicyAuthority: policy.authority, futureCollectionConsent: false };
    // This is historical entitlement, not a newly purchased rolling commitment.
    // Do not fabricate a term_key, contracted duration, price, tax or payment date.
    const patch = { term_start_date: start,
      config_id: config.id, renewal_policy_snapshot: policy,
      payment_method: h.payment_method || 'upfront', accounting_provider: 'xero',
      accounting_invoice_id: invoice.xero_document_id, accounting_invoice_number: invoice.invoice_number,
      xero_invoice_id: invoice.xero_document_id, xero_invoice_number: invoice.invoice_number,
      notes: JSON.stringify(authority) };
    repairs.push({ historyId: h.id, before: h, patch, invoice, config,
      start, end, kind, memberClass: cls });
  }
  if (!repairs.length) return hold('No legacy term gap requiring this repair');
  return { memberId: member.id, state: 'candidate', reason: 'Unique stored paid invoice; retained expiry and member class', repairs };
}
