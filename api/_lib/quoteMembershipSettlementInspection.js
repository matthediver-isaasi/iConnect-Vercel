import { getAccountingProviderByName } from './accountingProvider.js';
import { retrieveTenantPaymentIntent } from './stripeCredentials.js';
import { assertQuoteAccountingSource, verifyQuotePayment } from './quoteMembershipAccounting.js';
import { getValidXeroAccessToken } from './xero.js';

// Quote purchases have their own durable accounting worker. Inspection must
// not create a second settlement owner alongside that worker.
export async function inspectQuoteMembershipSettlement({ db, tenantId, recordId, table }, deps = {}) {
  if (table !== 'member_membership_history') return null;
  const { data: row, error } = await db.from('accounting_request_queue').select('*')
    .eq('tenant_id', tenantId).eq('source_type', 'stripe_member_quote')
    .eq('source_id', recordId).eq('operation', 'invoice').maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const history = await (deps.assertSource || assertQuoteAccountingSource)({ db, row });
  const invoiceId = history.accounting_invoice_id || history.xero_invoice_id;
  if (!invoiceId || invoiceId !== row.invoice_result?.id) throw new Error('Saved invoice linkage changed');
  const found = await (deps.retrieve || retrieveTenantPaymentIntent)(tenantId, 'membership', history.stripe_payment_intent_id);
  verifyQuotePayment(history, found?.paymentIntent);
  const company = await (deps.loadToken || getValidXeroAccessToken)(tenantId);
  if (row.provider !== 'xero' || company.tenantId !== row.company_id) throw new Error('Accounting company changed; review required');
  const provider = (deps.getProvider || getAccountingProviderByName)(row.provider);
  const status = await provider.fetchInvoiceStatus(invoiceId, tenantId);
  if (status.raw?.InvoiceID !== invoiceId) throw new Error('Accounting invoice identity could not be confirmed');
  // The payment ID, not a zero balance alone, proves this particular payment
  // was recorded. A credit note or unrelated payment can also close an invoice.
  const paymentId = row.payment_result?.paymentId || row.payment_result?.id;
  const payment = status.raw?.Payments?.find(p => p.PaymentID === paymentId);
  const recorded = !!payment && Number(payment.Amount) === Number(history.total_with_vat)
    && String(status.raw?.CurrencyCode).toUpperCase() === String(history.currency).toUpperCase();
  const settled = recorded && Number(status.balance) === 0 && !status.voided;
  return {
    read_only: true, invoice_id: invoiceId,
    invoice_number: history.accounting_invoice_number || history.xero_invoice_number,
    stripe_payment_intent_id: history.stripe_payment_intent_id,
    amount: Number(history.total_with_vat), currency: history.currency,
    balance: status.balance, payment_recorded: recorded,
    settlement_state: settled ? 'done' : 'review_required',
    summary: settled
      ? 'The member’s payment is recorded against this invoice. Nothing further is needed.'
      : 'The member has paid, but we could not confirm that the accounting record is fully reconciled. Ask your finance administrator to review it. Do not charge the member again.',
    guidance: 'This membership uses the automatic accounting process. Changes must go through that process so the same payment is not recorded twice. This screen checks the existing records only.',
  };
}
