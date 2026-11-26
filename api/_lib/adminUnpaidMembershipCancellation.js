import { createHash } from 'node:crypto';
import { createMemberAmendmentFinance, amendmentMinor } from './memberAmendmentFinance.js';

const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'unpaid_cancellation_review' }); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function result({ data, error }) {
  if (error) throw Object.assign(new Error('Cancellation could not be verified. Refresh the record or retry the existing cancellation; finance review may be required.'), { status: 409 });
  return data;
}
export function unpaidInvoiceId(history) {
  const id = history.accounting_invoice_id || history.xero_invoice_id;
  if (!id || (history.accounting_invoice_id && history.xero_invoice_id && history.accounting_invoice_id !== history.xero_invoice_id)) {
    fail('An unambiguous linked invoice is required. Ask finance to review this purchase.');
  }
  return id;
}
export function verifyUnpaidInvoice(history, response, providerTenantId, { allowVoided = false } = {}) {
  const invoice = response?.Invoices?.[0], id = unpaidInvoiceId(history);
  if (response?.Invoices?.length !== 1 || invoice?.InvoiceID !== id || invoice.Type !== 'ACCREC'
    || !providerTenantId || !invoice.Contact?.ContactID || invoice.CurrencyCode !== history.currency
    || !['AUTHORISED', ...(allowVoided ? ['VOIDED'] : [])].includes(invoice.Status)) {
    fail('The invoice identity, currency or accounting status does not match this unpaid membership. Finance must review the invoice.');
  }
  // Xero can omit AmountCredited entirely on an invoice with no credits.
  // Only that absent property is optional: null/malformed supplied values and
  // every required amount still fail. The balance and allocation checks below
  // independently require a wholly unpaid invoice (or its confirmed void).
  const paidMinor = amendmentMinor(invoice.AmountPaid, 'invoice paid amount');
  const creditedMinor = Object.hasOwn(invoice, 'AmountCredited')
    ? amendmentMinor(invoice.AmountCredited, 'invoice credited amount') : 0;
  const dueMinor = amendmentMinor(invoice.AmountDue, 'invoice outstanding amount');
  const grossMinor = amendmentMinor(invoice.Total, 'invoice total');
  const netMinor = amendmentMinor(invoice.SubTotal, 'invoice subtotal');
  const vatMinor = amendmentMinor(invoice.TotalTax, 'invoice tax amount');
  if (paidMinor !== 0 || creditedMinor !== 0
    || invoice.Payments?.length || invoice.CreditNotes?.length || invoice.Prepayments?.length || invoice.Overpayments?.length
    || grossMinor <= 0 || grossMinor !== amendmentMinor(history.total_with_vat, 'membership total')
    || vatMinor !== amendmentMinor(history.vat_amount, 'membership tax amount')
    || netMinor + vatMinor !== grossMinor
    || (invoice.Status === 'AUTHORISED' && dueMinor !== grossMinor)
    || (invoice.Status === 'VOIDED' && dueMinor !== 0)) {
    fail('The invoice must be wholly unpaid, without payments or credits, and match the original membership. Finance must review any mismatch.');
  }
  return { id, providerTenantId, contactId: invoice.Contact.ContactID, currency: invoice.CurrencyCode,
    grossMinor, netMinor, vatMinor, paidMinor, creditedMinor, dueMinor, status: invoice.Status };
}
function sameInvoice(current, approved) {
  return ['id', 'providerTenantId', 'contactId', 'currency', 'grossMinor', 'netMinor', 'vatMinor']
    .every(key => current[key] === approved[key]);
}

/** Invoice voiding is a desired-state operation with one persisted idempotency
 * key. A lost response is recovered by reading Xero, never by assuming success. */
export function createAdminUnpaidMembershipCancellation({
  db, accountingForTenant = createMemberAmendmentFinance().accountingClient,
}) {
  function actor(context) {
    if (context.actorKind !== 'admin' || !context.tenantId || !context.memberId || !context.actorId) fail('An authenticated finance administrator is required.');
  }
  async function operations(context) {
    return result(await db.from('form_initial_checkout_recovery').select('*')
      .eq('tenant_id', context.tenantId).eq('member_id', context.memberId)
      .in('state', ['reconciling', 'released']).order('created_at', { ascending: false }).limit(1));
  }
  async function candidate(context) {
    const rows = result(await db.from('member_membership_history').select('*')
      .eq('tenant_id', context.tenantId).eq('member_id', context.memberId)
      .is('cancelled_for_switch_at', null).limit(2));
    return { hasHistory: !!rows?.length, history: rows?.length === 1 && rows[0].status === 'pending_payment_setup'
      && rows[0].payment_status === 'unpaid' && rows[0].payment_method === 'invoice' ? rows[0] : null };
  }
  async function status(context) {
    actor(context);
    const [ops, { history, hasHistory }] = await Promise.all([operations(context), candidate(context)]);
    const op = ops?.[0];
    if (op?.snapshot?.adminUnpaidCancellation && op.state === 'reconciling') {
      return { pending: true, operationId: op.id };
    }
    return { eligible: !!history, invoiceNumber: history?.accounting_invoice_number || history?.xero_invoice_number,
      completed: !hasHistory && op?.state === 'released' && !!op.snapshot?.adminUnpaidCancellation };
  }
  async function preview(context) {
    actor(context);
    const { history } = await candidate(context);
    if (!history || history.paid_at || history.billing_agreement_id || history.previous_term_id
      || history.membership_successor_election_id || history.membership_payment_quote_id || history.stripe_payment_intent_id
      || (history.accounting_provider && history.accounting_provider !== 'xero')
      || (history.commitment_snapshot?.payment_frequency && history.commitment_snapshot.payment_frequency !== 'upfront')) {
      fail('Only an initial unpaid invoice membership can be reset here. Other purchases need finance review.');
    }
    const client = await accountingForTenant(context.tenantId);
    const invoice = verifyUnpaidInvoice(history, await client.request(`Invoices/${encodeURIComponent(unpaidInvoiceId(history))}`), client.xeroTenantId);
    return { history, invoice, fingerprint: fingerprint({ history, invoice }) };
  }
  async function resume(context, id) {
    actor(context);
    const op = result(await db.from('form_initial_checkout_recovery').select('*')
      .eq('tenant_id', context.tenantId).eq('member_id', context.memberId).eq('id', id).maybeSingle());
    if (!op?.snapshot?.adminUnpaidCancellation) fail('The owned unpaid membership cancellation was not found.');
    if (op.state === 'released') return { state: 'released', operationId: op.id };
    if (op.state !== 'reconciling') fail('This cancellation requires finance review.');
    const history = op.snapshot.histories?.[0], approved = op.snapshot.adminUnpaidCancellation.invoice;
    const client = await accountingForTenant(context.tenantId);
    if (client.xeroTenantId !== approved.providerTenantId) fail('The connected accounting organisation changed. Finance review is required.');
    const path = `Invoices/${encodeURIComponent(approved.id)}`;
    const read = async () => {
      const receipt = verifyUnpaidInvoice(history, await client.request(path), client.xeroTenantId, { allowVoided: true });
      if (!sameInvoice(receipt, approved)) fail('The invoice changed after approval. Finance review is required.');
      return receipt;
    };
    let receipt = await read();
    if (receipt.status !== 'VOIDED') {
      await client.request(path, { method: 'POST', key: `unpaid-membership-${op.id}`,
        body: { Invoices: [{ InvoiceID: approved.id, Status: 'VOIDED' }] } });
      receipt = await read();
    }
    if (receipt.status !== 'VOIDED') fail('Invoice cancellation is not confirmed. Retry the existing cancellation; do not start a second purchase.');
    const released = result(await db.rpc('finish_admin_unpaid_membership_cancellation', {
      p_tenant_id: context.tenantId, p_member_id: context.memberId, p_recovery_id: op.id,
      p_actor_id: context.actorId, p_receipt: receipt,
    }));
    if (released !== true) fail('The invoice is cancelled but membership release is not yet confirmed. Retry this cancellation.');
    return { state: 'released', operationId: op.id };
  }
  async function confirm(context, input) {
    if (input.approve !== true || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')
      || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.trim().length > 1000) {
      fail('Review the current preview, explicitly confirm cancellation, and give a reason.');
    }
    const current = await preview(context);
    if (current.fingerprint !== input.fingerprint) fail('The membership or invoice changed. Preview again before cancelling.');
    const op = result(await db.rpc('begin_admin_unpaid_membership_cancellation', {
      p_tenant_id: context.tenantId, p_member_id: context.memberId, p_actor_id: context.actorId,
      p_history: current.history, p_invoice: current.invoice, p_reason: input.reason.trim(),
    }));
    return resume(context, op.id);
  }
  return { status, preview: async context => {
    const p = await preview(context);
    return { fingerprint: p.fingerprint, invoiceNumber: p.history.accounting_invoice_number || p.history.xero_invoice_number,
      grossMinor: p.invoice.grossMinor, currency: p.invoice.currency };
  }, confirm, resume };
}
