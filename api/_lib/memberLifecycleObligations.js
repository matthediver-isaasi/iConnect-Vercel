import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';

const settled = new Set(['paid', 'settled', 'refunded', 'void', 'voided', 'deleted']);
const bookingSettled = new Set(['paid','settled','refunded']);
const pattern = value => `^${String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const lower = value => String(value || '').toLowerCase();

export function lifecycleInvoiceBlocker(row) {
  if (row.check_error || row.accounting_status_error) return 'invoice_status_unverified';
  const payment = lower(row.accounting_payment_status || row.payment_status);
  const status = lower(row.accounting_status || row.invoice_status || row.status);
  if (settled.has(payment) || ['void', 'voided', 'deleted'].includes(status)) return null;
  // Paid import labels alone are not current provider settlement evidence.
  return payment || status ? 'unresolved_invoice' : 'invoice_status_unverified';
}

export async function loadLifecycleObligations(db, tenantId, member, policy, now, read) {
  const blockers = new Set();
  const references = {};
  if (!member.email?.trim() && !member.lifecycle_financial_refs) blockers.add('financial_identity_unavailable');
  const load = async (table, filters, options) => {
    const rows = [...await read(db, table, tenantId, filters, options)];
    if (['event','complex_event'].includes(table)) return rows;
    const key = options?.keyColumns?.[0] || 'id';
    const retained = member.lifecycle_financial_refs?.[table] || [];
    if (!Array.isArray(retained) || retained.length > 10000
      || retained.some(value => typeof value !== 'string' || !value || value.length > 200)) throw new Error('Invalid retained financial links');
    for (let start=0; start<retained.length; start+=100) {
      rows.push(...await read(db, table, tenantId, [[key, retained.slice(start,start+100), 'in']], options));
    }
    const unique = [...new Map(rows.map(row=>[row[key],row])).values()];
    if (unique.some(row=>!row[key])) throw new Error('Financial source identity unavailable');
    references[table] = [...new Set([...(references[table] || []),...unique.map(row=>row[key])])];
    return unique;
  };
  const terms = await load('member_membership_history', [['member_id', member.id]]);
  for (const row of terms) {
    if (['cancelled', 'canceled', 'void', 'replaced', 'expired_checkout'].includes(lower(row.status))) continue;
    const noCharge = row.final_cost != null && Number(row.final_cost) === 0 && lower(row.payment_status) === 'waived';
    if (!noCharge && !settled.has(lower(row.payment_status))) blockers.add('membership_settlement_unresolved');
  }
  for (const table of ['historical_member_invoice', 'public_invoice_po_billing']) {
    const invoices = await load(table, [['member_id', member.id]]);
    for (const row of invoices) {
      const reason = lifecycleInvoiceBlocker(row);
      if (reason) blockers.add(reason);
    }
  }
  const attempts = await load('booking_credit_attempt', [['member_id', member.id]], { keyColumns: ['purchase_key'] });
  for (const row of attempts) {
    if (!['failed', 'reversed'].includes(row.state) && !(row.state === 'committed' && row.invoice_state === 'complete')) {
      blockers.add('booking_payment_or_refund_pending');
    }
  }
  const pendingInvoices = await load('unified_booking_invoice', [['booker_member_id', member.id]], { keyColumns: ['purchase_key'] });
  for (const row of pendingInvoices) {
    if (!['queued', 'not_applicable'].includes(row.state)) blockers.add('booking_invoice_pending');
    if(row.state==='queued' && lifecycleInvoiceBlocker(row))blockers.add('booking_invoice_settlement_unverified');
    if (!['completed', 'not_applicable'].includes(row.provision_state)) blockers.add('booking_provisioning_pending');
  }
  const vouchers = await load('voucher', [['member_id', member.id]]);
  for (const voucher of vouchers) {
    if (Number(voucher.value) <= 0 || ['expired', 'cancelled', 'redeemed'].includes(lower(voucher.status))) continue;
    try {
      if (!voucher.expires_at || lifecycleDay(voucher.expires_at, policy.timezone) >= lifecycleDay(now, policy.timezone)) {
        blockers.add('unspent_member_credit');
      }
    } catch { blockers.add('member_credit_expiry_unverified'); }
  }
  const submissions = [...await load('form_submission', [['created_member_id', member.id]])];
  if (member.email) submissions.push(...await load('form_submission', [['submitted_by_email', pattern(member.email), 'imatch']]));
  for (const row of new Map(submissions.map(row => [row.id, row])).values()) {
    if (!row.payment_provider && !row.payment_amount) continue;
    if (row.payment_amount == null || !Number.isFinite(Number(row.payment_amount))
      || (Number(row.payment_amount) > 0 && !settled.has(lower(row.payment_status)))) {
      blockers.add('form_payment_or_invoice_unresolved');
    }
    const refund = row.payment_meta?.refund_status;
    if (refund && !['completed', 'succeeded', 'refunded'].includes(lower(refund))) blockers.add('form_refund_pending');
  }
  for (const table of ['booking', 'complex_event_booking']) {
    const rows = [...await load(table, [['member_id', member.id]])];
    if (member.email) rows.push(...await load(table, [['attendee_email', pattern(member.email), 'imatch']]));
    for (const row of new Map(rows.map(row => [row.id, row])).values()) {
      const amount=row.total_cost ?? row.total_price ?? row.ticket_price;
      if(amount==null || amount==='' || !Number.isFinite(Number(amount)) || Number(amount)<0){
        blockers.add('booking_charge_unverified');
      }else if(Number(amount)>0 && !bookingSettled.has(lower(row.payment_status))){
        blockers.add('booking_settlement_unverified');
      }
      for(const refund of [row.refund_status,row.payment_meta?.refund_status]){
        if(refund && !['none','not_applicable','completed','succeeded','refunded'].includes(lower(refund))){
          blockers.add('booking_refund_unresolved');
        }
      }
      if (['cancelled', 'canceled'].includes(lower(row.status))) {
        // Cancellation is not evidence that financial obligations were settled.
        if (Number(row.ticket_price) > 0 && !settled.has(lower(row.payment_status))) blockers.add('cancelled_booking_finances_unverified');
        if(Number(amount)>0 && !['completed','succeeded','refunded','not_applicable'].includes(lower(row.refund_status || row.payment_meta?.refund_status))){
          blockers.add('cancelled_booking_refund_unverified');
        }
        continue;
      }
      if (row.status !== 'confirmed') { blockers.add('booking_incomplete'); continue; }
      const events = await load(table === 'booking' ? 'event' : 'complex_event', [['id', row.event_id]]);
      if (events.length !== 1 || !events[0].start_date) { blockers.add('booking_event_date_unverified'); continue; }
      try {
        if (lifecycleDay(events[0].end_date || events[0].start_date, policy.timezone) >= lifecycleDay(now, policy.timezone)) {
          blockers.add('future_or_current_event_booking');
        }
      } catch { blockers.add('booking_event_date_unverified'); }
    }
  }
  return { complete: true, blockers: [...blockers].sort(), references };
}
