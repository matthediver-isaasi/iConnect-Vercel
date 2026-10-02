import { recoveryRpc, validRecoverySnapshot, EventInvoiceRecoveryError } from './eventInvoiceRecovery.js';
import { eventTicketLineAmountType, eventTicketTaxAmount } from './eventInvoiceProducer.js';

const fail = code => { throw new EventInvoiceRecoveryError(`historical_${code}`); };
const unique = (rows, key) => {
  const values = [...new Set(rows.map(row => row[key] ?? null))];
  if (values.length !== 1) fail(`${key}_ambiguous`);
  return values[0];
};
const money = value => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) fail('amount_missing');
  return Number(value);
};

// User-authorised policy: event/ticket details do not change after booking.
// This is deliberately NOT permission to infer tax from account defaults, use
// attendee identity, reprice a booking, or reinterpret a test Stripe receipt.
export function reconstructHistoricalEventInvoice(input) {
  const { candidate, bookings, event, tickets, organization, member, providers } = input;
  if (!candidate || !Array.isArray(bookings) || !bookings.length || !event) fail('booking_evidence_missing');
  if (bookings.some(b => b.tenant_id !== candidate.tenantId || b.event_id !== event.id
    || b.booking_group_reference !== candidate.bookingGroupReference
    || ['cancelled', 'canceled', 'refunded', 'failed', 'pending_payment'].includes(b.status))) fail('booking_scope_changed');
  const method = unique(bookings, 'payment_method');
  if (!['invoice', 'account'].includes(method)) fail('verified_live_settlement_required');
  const dates = bookings.map(b => String(b.created_at || '').slice(0, 10));
  if (new Set(dates).size !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(dates[0])
    || !Number.isFinite(Date.parse(dates[0]))) fail('invoice_date_ambiguous');
  const orgId = unique(bookings, 'organization_id');
  const memberId = unique(bookings, 'member_id');
  if (bookings.some(b => b.is_guest_booking || b.purchaser_context)) fail('purchaser_requires_review');
  const buyer = orgId ? organization : member;
  if (!buyer || buyer.tenant_id !== candidate.tenantId || buyer.id !== (orgId || memberId)) fail('purchaser_missing');
  const name = orgId ? buyer.name : `${buyer.first_name || ''} ${buyer.last_name || ''}`.trim();
  if (!name) fail('purchaser_missing');
  const email = orgId ? buyer.invoicing_email : buyer.email;
  const contact = { name, email: email || null, provenance: { kind: orgId ? 'organization' : 'member', id: buyer.id } };
  const Contact = buyer.xero_contact_id ? { ContactID: buyer.xero_contact_id } : { Name: name, ...(email ? { EmailAddress: email } : {}) };
  const lines = [];
  const currencies = [];
  const policies = [];
  let total = 0;
  for (const b of bookings) {
    const matches = tickets.filter(t => String(t.id) === String(b.ticket_class_id));
    if (matches.length !== 1) fail('ticket_ambiguous');
    const ticket = matches[0];
    // Missing is not zero, even where Xero previously supplied an account default.
    if (!ticket.vat_rate_key || ticket.vat_rate_percentage == null
      || ticket.vat_rate_percentage === '' || !Number.isFinite(Number(ticket.vat_rate_percentage))
      || Number(ticket.vat_rate_percentage) < 0) fail('tax_evidence_missing');
    let policy;
    try { policy = eventTicketLineAmountType(ticket); }
    catch { fail('line_amount_policy_invalid'); }
    policies.push(policy);
    if (policy !== 'Inclusive' && Number(ticket.vat_rate_percentage) !== 0) fail('tax_total_requires_review');
    if (!event.xero_account_code?.trim()) fail('sales_account_missing');
    for (const key of ['voucher_amount', 'training_fund_amount', 'discount_code_amount']) {
      if (b[key] != null && money(b[key]) !== 0) fail('credit_allocation_requires_review');
    }
    const amount = money(b.ticket_price);
    if (amount <= 0 || (b.total_cost != null && money(b.total_cost) !== amount)
      || (method === 'account' && (b.account_amount == null || money(b.account_amount) !== amount))) fail('amount_ambiguous');
    const currency = b.currency || ticket.currency;
    if (!/^[A-Z]{3}$/.test(String(currency || '').toUpperCase())) fail('currency_missing');
    currencies.push(String(currency).toUpperCase());
    total += amount;
    lines.push({ Description: `Event: ${event.title}\nTicket: ${ticket.name}\nBooking: ${candidate.bookingGroupReference}`,
      Quantity: 1, UnitAmount: amount, TaxAmount: eventTicketTaxAmount(amount, ticket.vat_rate_percentage, policy),
      TaxType: ticket.vat_rate_key, AccountCode: event.xero_account_code.trim() });
  }
  if (new Set(currencies).size !== 1) fail('currency_ambiguous');
  if (new Set(policies).size !== 1) fail('line_amount_policy_ambiguous');
  if (providers?.length !== 1 || !providers[0].id || !providers[0].tenant_id
    || providers[0].tenant_id === 'PENDING_SELECTION') fail('provider_binding_ambiguous');
  const date = dates[0];
  const due = new Date(`${date}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + 30);
  const searchEnd = new Date(`${date}T00:00:00Z`); searchEnd.setUTCDate(searchEnd.getUTCDate() + 365);
  const currency = currencies[0];
  const snapshot = { version: 1, contact, paymentMethod: 'invoice', amount: Number(total.toFixed(2)), currency,
    reconstruction: { policy: 'original-ticket-v1', bookingFingerprint: candidate.bookingFingerprint,
      eventId: event.id, ticketEvidence: structuredClone(tickets.filter(t => bookings.some(b => String(b.ticket_class_id) === String(t.id)))),
      purchaser: contact.provenance },
    provider: { connectionId: providers[0].id, xeroTenantId: providers[0].tenant_id }, settlement: null,
    invoice: { Type: 'ACCREC', Status: 'DRAFT', Contact, Date: date, DueDate: due.toISOString().slice(0, 10),
      CurrencyCode: currency, LineAmountTypes: policies[0], LineItems: lines,
      Reference: unique(bookings, 'po_to_follow') ? 'TBC' : (unique(bookings, 'purchase_order_number') || 'TBC') },
    legacyDiscovery: { version: 1, fromDate: date, toDate: searchEnd.toISOString().slice(0, 10),
      bookingReference: candidate.bookingGroupReference, conservativeHistorical: true, eventTitle: event.title },
  };
  if (!validRecoverySnapshot(snapshot)) fail('financial_evidence_invalid');
  return snapshot;
}

export async function reconstructHistoricalEventInvoices({ db, limit, operationId, deadlineAt }) {
  const inputs = await recoveryRpc(db, 'automatic_candidates', { p_limit: Math.min(limit, 20), p_id: operationId }, deadlineAt);
  if (!Array.isArray(inputs)) throw new Error('Historical reconstruction candidates unavailable');
  for (const input of inputs) {
    if (Date.now() >= deadlineAt - 1000) break;
    let snapshot = null; let reason = null;
    try { snapshot = reconstructHistoricalEventInvoice(input); }
    catch (error) {
      if (!(error instanceof EventInvoiceRecoveryError)) throw error;
      reason = error.code;
    }
    await recoveryRpc(db, 'automatic_commit', { p_input: input, p_snapshot: snapshot, p_reason: reason }, deadlineAt);
  }
}