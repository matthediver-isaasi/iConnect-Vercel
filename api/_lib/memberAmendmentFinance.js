import { AmendmentError } from './memberAmendmentQuote.js';
import { getAccountingProvider } from './accountingProvider.js';
import { buildXeroSalesInvoicePayload } from './xero.js';
import { discoverInvoiceCredits } from './invoiceCreditDiscovery.js';
import { retrieveTenantPaymentIntent } from './stripeCredentials.js';

const fail = (message) => { throw new AmendmentError(message, 422, 'finance_evidence_required'); };
export function amendmentMinor(value, label = 'provider amount') {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)
      || !Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) {
    fail(`Exact ${label} in two-decimal currency is required.`);
  }
  return Math.round(n * 100);
}
export function amendmentMoney(quote, choice) {
  const { netMinor, vatMinor, grossMinor } = quote.delta;
  if (![netMinor, vatMinor, grossMinor].every(Number.isSafeInteger) || netMinor + vatMinor !== grossMinor
      || (grossMinor > 0 && (netMinor < 0 || vatMinor < 0))
      || (grossMinor < 0 && (netMinor > 0 || vatMinor > 0))
      || (!grossMinor && (netMinor || vatMinor))) {
    fail('Mixed-sign net/VAT and tax-only adjustments require separate accounting review.');
  }
  if (!(choice === 'collect' && grossMinor > 0 || ['credit', 'refund'].includes(choice) && grossMinor < 0
      || choice === 'none' && grossMinor === 0)) fail('Settlement choice does not match the quoted adjustment.');
  return { netMinor: Math.abs(netMinor), taxMinor: Math.abs(vatMinor), grossMinor: Math.abs(grossMinor) };
}

/** Xero invoice collection and retained credit; cash refunds are independently
 * verified recorded manual refunds, never an assertion that Xero sent money. */
export function createMemberAmendmentFinance({
  providerForTenant = getAccountingProvider, fetcher = fetch,
  paymentIntentForTenant = retrieveTenantPaymentIntent,
} = {}) {
  async function verifyOriginalCard(amendment) {
    const q = amendment.quote;
    const source = q.sourceSnapshot;
    if (source.payment_method !== 'stripe') return;
    if (!source.stripe_payment_intent_id) fail('Original card refund capacity cannot be verified without its saved payment intent.');
    const payment = await paymentIntentForTenant(amendment.tenant_id, 'membership', source.stripe_payment_intent_id, { timeoutMs: 10000 });
    const pi = payment?.paymentIntent;
    if (pi?.id !== source.stripe_payment_intent_id || pi.status !== 'succeeded'
        || pi.metadata?.tenant_id !== amendment.tenant_id || pi.metadata?.member_id !== amendment.member_id
        || !pi.customer
        || pi.currency?.toUpperCase() !== q.currency || pi.amount_received !== q.originalFullTerm.grossMinor
        || !pi.latest_charge) fail('Original card payment ownership, settlement and refundable capacity cannot be verified.');
    const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
    const charge = await payment.stripe.charges.retrieve(chargeId);
    if (charge?.id !== chargeId || charge.payment_intent !== pi.id || charge.paid !== true
        || charge.customer !== (typeof pi.customer === 'string' ? pi.customer : pi.customer.id)
        || charge.disputed || charge.amount_refunded !== 0 || charge.currency?.toUpperCase() !== q.currency
        || charge.amount !== q.originalFullTerm.grossMinor) {
      fail('Original card payment has refunds/disputes or mismatched ownership; remaining credit capacity needs finance review.');
    }
  }
  async function client(tenantId) {
    const provider = await providerForTenant(tenantId);
    if (provider.name !== 'xero') fail('Connected settlement currently requires Xero; this accounting provider is unsupported.');
    const { accessToken, tenantId: xeroTenantId } = await provider.getRawAccessToken(tenantId);
    const deadline = Date.now() + 20000;
    const request = async (path, { method = 'GET', body, key } = {}) => {
      const remaining = deadline - Date.now();
      if (remaining < 250) throw new AmendmentError('Accounting verification deadline exceeded; read-only reconciliation is required.', 503, 'verification_deadline');
      const response = await fetcher(`https://api.xero.com/api.xro/2.0/${path}`, {
        method, headers: {
          Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': xeroTenantId,
          Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}),
        }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.min(12000, remaining)),
      });
      if (!response.ok) throw new AmendmentError('Accounting provider request failed; reconciliation may be required.', 502, 'accounting_request_failed');
      const result = await response.json();
      if (result?.ErrorNumber || result?.Elements?.some(e => e.HasErrors)) fail('Accounting provider rejected the amendment document.');
      return result;
    };
    return { provider, request, xeroTenantId };
  }
  async function verifyOriginal(amendment) {
    const q = amendment.quote;
    const source = q.sourceSnapshot;
    if (source.billing_agreement_id || source.commitment_snapshot?.payment_frequency !== 'upfront') {
      fail('Monthly/provider-linked commitments require the dedicated monthly amendment service.');
    }
    if (source.accounting_provider && source.accounting_provider !== 'xero') fail('Original purchase belongs to a different accounting provider.');
    const invoiceId = source.accounting_invoice_id || source.xero_invoice_id;
    if (!invoiceId || (source.accounting_invoice_id && source.xero_invoice_id && source.accounting_invoice_id !== source.xero_invoice_id)) {
      fail('An unambiguous original source-linked invoice is required; the member is not assumed to be the payer.');
    }
    const { request, xeroTenantId } = await client(amendment.tenant_id);
    const data = await request(`Invoices/${encodeURIComponent(invoiceId)}`);
    const invoice = data?.Invoices?.[0];
    if (data?.Invoices?.length !== 1 || invoice?.InvoiceID !== invoiceId || invoice.Type !== 'ACCREC'
        || !invoice.Contact?.ContactID || invoice.CurrencyCode !== q.currency || invoice.Status !== 'PAID'
        || amendmentMinor(invoice.AmountDue) !== 0 || amendmentMinor(invoice.AmountCredited) !== 0
        || amendmentMinor(invoice.Total) !== q.originalFullTerm.grossMinor
        || amendmentMinor(invoice.SubTotal) !== q.originalFullTerm.netMinor
        || amendmentMinor(invoice.TotalTax) !== q.originalFullTerm.vatMinor
        || amendmentMinor(invoice.AmountPaid) !== q.originalFullTerm.grossMinor
        || !invoice.Payments?.length || invoice.Payments.length > 25) {
      fail('Original payer invoice must exactly match the purchase, be fully paid without credits, and have identifiable payment evidence.');
    }
    // Refuse mixed product/tax/revenue invoices: never allocate an amendment to
    // another product or infer which party paid from the member's email.
    const accounts = [...new Set((invoice.LineItems || []).map(line => line.AccountCode))];
    const taxes = [...new Set((invoice.LineItems || []).map(line => line.TaxType))];
    if (accounts.length !== 1 || !accounts[0] || taxes.length !== 1 || !taxes[0]) {
      fail('Mixed or unidentified source revenue/tax lines need accounting review.');
    }
    let originalPaid = 0;
    const originalPaymentIds = new Set();
    for (const item of invoice.Payments) {
      if (!item.PaymentID) fail('Original invoice payment ownership is missing.');
      if (originalPaymentIds.has(item.PaymentID)) fail('Original invoice has duplicate payment evidence.');
      originalPaymentIds.add(item.PaymentID);
      const paymentResponse = await request(`Payments/${encodeURIComponent(item.PaymentID)}`);
      const payment = paymentResponse?.Payments?.[0];
      if (paymentResponse?.Payments?.length !== 1 || payment?.PaymentID !== item.PaymentID || payment.Status !== 'AUTHORISED'
          || payment.Invoice?.InvoiceID !== invoiceId || !payment.Account?.AccountID) {
        fail('Original invoice payment ownership could not be independently verified.');
      }
      const amount = amendmentMinor(payment.Amount);
      if (amount <= 0) fail('Original invoice payment amount must be positive.');
      originalPaid += amount;
    }
    if (originalPaid !== q.originalFullTerm.grossMinor) fail('Original invoice payment total differs from the purchased commitment.');
    const coverage = await discoverInvoiceCredits({
      provider: 'xero', invoiceId,
      readInvoice: async () => invoice,
      listNotes: async (contactId, page) => {
        const where = encodeURIComponent(`Contact.ContactID==Guid("${contactId}")`);
        return (await request(`CreditNotes?where=${where}&page=${page}`))?.CreditNotes;
      },
    });
    if (!coverage.complete || coverage.notes.length) {
      fail('Existing or unattributed payer credits prevent a verified refundable/creditable balance; finance review is required.');
    }
    await verifyOriginalCard(amendment);
    const original = {
      provider: 'xero', xeroTenantId, sourceInvoiceId: invoiceId,
      contactId: invoice.Contact.ContactID, currency: q.currency,
      originalPaymentIds: [...originalPaymentIds].sort(),
      originalPaidMinor: originalPaid, originalAmounts: { ...q.originalFullTerm },
      accountCode: accounts[0], taxCode: taxes[0],
      payerEmail: invoice.Contact.EmailAddress || null,
    };
    const expected = q.fundingEvidence;
    if (expected && (
      expected.provider !== original.provider
      || expected.providerTenantId !== original.xeroTenantId
      || expected.sourceInvoiceId !== original.sourceInvoiceId
      || expected.contactId !== original.contactId
      || expected.paidMinor !== original.originalPaidMinor
      || JSON.stringify(expected.paymentIds) !== JSON.stringify(original.originalPaymentIds)
      || ['netMinor', 'vatMinor', 'grossMinor'].some(key =>
        expected.originalAmounts?.[key] !== original.originalAmounts[key])
    )) fail('The original funding changed since confirmation. Review the amendment before starting settlement.');
    return original;
  }
  async function prepare(amendment, choice) {
    const q = amendment.quote;
    const amounts = amendmentMoney(q, choice);
    // A zero adjustment is not proof that the original purchase was paid.
    // Verify the same source invoice/card evidence before every entitlement
    // change, including a lateral move with no new accounting document.
    const original = await verifyOriginal(amendment);
    if (choice === 'none') return { ...original, provider: 'none', amounts };
    if (amounts.grossMinor > q.originalFullTerm.grossMinor && choice !== 'collect') fail('Credit exceeds the original paid amount.');
    let targetTax;
    const target = q.targetSnapshot.band || q.targetSnapshot.config;
    const rawTax = q.targetSnapshot.band ? target.vat_rate : target.flat_vat_rate;
    if (rawTax) {
      try { targetTax = (typeof rawTax === 'string' ? JSON.parse(rawTax) : rawTax)?.taxType; } catch { /* explicit blocker below */ }
    }
    // A single tax type can represent a difference exactly only when the
    // original and target tax regimes match. No reverse-engineered VAT rate.
    if (targetTax && targetTax !== original.taxCode) fail('Tax-regime changes need separate debit and credit documents.');
    if (!targetTax && (q.originalFullTerm.vatMinor || amounts.taxMinor)) fail('Missing target tax type or changed tax regime requires separate debit and credit documents.');
    return {
      ...original, amounts,
      reference: `MA:${amendment.id}`, issueDate: q.effectiveDate,
      // Preserve original payer, not a mutable member contact lookup.
      payerEmail: original.payerEmail,
    };
  }
  function accepted(context) {
    return {
      customerId: context.contactId, currency: context.currency, ...context.amounts,
      issueDate: context.issueDate, dueDate: context.issueDate,
      customerReference: context.reference, idempotencyKey: context.reference,
      lines: [{
        description: `Membership amendment ${context.reference}; original invoice ${context.sourceInvoiceId}`,
        quantity: '1', ...context.amounts, accountCode: context.accountCode, taxCode: context.taxCode,
      }],
    };
  }
  function verifyDocument(doc, context, choice) {
    const isInvoice = choice === 'collect';
    const id = isInvoice ? doc?.InvoiceID : doc?.CreditNoteID;
    if (!id || doc.Contact?.ContactID !== context.contactId || doc.CurrencyCode !== context.currency
        || doc.Reference !== context.reference || !['AUTHORISED', 'PAID'].includes(doc.Status)
        || doc.Type !== (isInvoice ? 'ACCREC' : 'ACCRECCREDIT')
        || amendmentMinor(doc.SubTotal) !== context.amounts.netMinor
        || amendmentMinor(doc.TotalTax) !== context.amounts.taxMinor
        || amendmentMinor(doc.Total) !== context.amounts.grossMinor
        || doc.LineItems?.length !== 1
        || doc.LineItems[0].AccountCode !== context.accountCode || doc.LineItems[0].TaxType !== context.taxCode) {
      fail('Provider document does not exactly match the reserved payer, reference, currency, revenue and net/VAT/gross.');
    }
    return id;
  }
  async function inspect(amendment, settlement) {
    const c = settlement.context;
    if (settlement.choice === 'none') {
      const original = await verifyOriginal(amendment);
      if (original.sourceInvoiceId !== c.sourceInvoiceId || original.contactId !== c.contactId
          || original.xeroTenantId !== c.xeroTenantId
          || JSON.stringify(original.originalPaymentIds) !== JSON.stringify(c.originalPaymentIds)) {
        fail('Original payment evidence changed after the zero-difference reservation.');
      }
      return { state: 'settled', evidence: {
        kind: 'zero_difference', verified: true,
        sourceInvoiceId: original.sourceInvoiceId,
        originalPaymentIds: original.originalPaymentIds,
      } };
    }
    const { request, xeroTenantId } = await client(amendment.tenant_id);
    if (xeroTenantId !== c.xeroTenantId) fail('Accounting connection changed; original organisation reconciliation is required.');
    const invoice = settlement.choice === 'collect';
    const resource = invoice ? 'Invoices' : 'CreditNotes';
    const query = encodeURIComponent(`Reference=="${c.reference}"`);
    const rows = (await request(`${resource}?where=${query}`))?.[resource];
    if (!Array.isArray(rows) || rows.length !== 1) {
      return { state: 'uncertain', evidence: { reason: rows?.length ? 'ambiguous_provider_documents' : 'provider_document_not_found', reference: c.reference } };
    }
    const id = verifyDocument(rows[0], c, settlement.choice);
    // Collection query summaries are not sufficient settlement evidence.
    const doc = (await request(`${resource}/${encodeURIComponent(id)}`))?.[resource]?.[0];
    verifyDocument(doc, c, settlement.choice);
    const evidence = { verified: true, provider: 'xero', documentId: id, reference: c.reference,
      sourceInvoiceId: c.sourceInvoiceId, contactId: c.contactId, amounts: c.amounts };
    if (invoice) {
      await verifyOriginalCard(amendment);
      const credited = amendmentMinor(doc.AmountCredited);
      if (credited !== 0) fail('An amendment invoice settled with credit is not verified additional-payment collection.');
      if (doc.Status !== 'PAID' || amendmentMinor(doc.AmountDue) !== 0
          || amendmentMinor(doc.AmountPaid) !== c.amounts.grossMinor) {
        let url = null;
        const online = await request(`Invoices/${encodeURIComponent(id)}/OnlineInvoice`);
        url = online?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
        return { state: 'awaiting_payment', evidence: { ...evidence, paymentUrl: url } };
      }
      let paid = 0;
      const paymentIds = [];
      if ((doc.Payments || []).length > 25) fail('Adjustment payment coverage exceeds the safe verification bound.');
      for (const entry of doc.Payments || []) {
        if (paymentIds.includes(entry.PaymentID)) fail('Adjustment invoice has duplicate payment identities.');
        const p = (await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments?.[0];
        if (!entry.PaymentID || p?.PaymentID !== entry.PaymentID || p.Status !== 'AUTHORISED'
            || p.Invoice?.InvoiceID !== id || !p.Account?.AccountID) fail('Adjustment invoice payment ownership verification failed.');
        const amount = amendmentMinor(p.Amount);
        if (amount <= 0) fail('Adjustment payment amount must be positive.');
        paid += amount;
        paymentIds.push(p.PaymentID);
      }
      if (!paymentIds.length || paid !== c.amounts.grossMinor) fail('Adjustment invoice payment total is not verified.');
      return { state: 'settled', evidence: { ...evidence, kind: 'collected', paymentIds } };
    }
    if (settlement.choice === 'credit') {
      await verifyOriginalCard(amendment);
      // Before application, spent or allocated credit needs review. Never later
      // permit changing this choice into a refund.
      if (doc.Status !== 'AUTHORISED' || amendmentMinor(doc.RemainingCredit) !== c.amounts.grossMinor
          || doc.Allocations?.length || doc.Payments?.length) fail('Retained credit has been consumed or allocated; review required.');
      return { state: 'settled', evidence: { ...evidence, kind: 'retained_credit' } };
    }
    // Manual cash refund: Xero does not transfer money. Only independently
    // reconciled bank refund entries consuming the entire note prove recording.
    if (amendmentMinor(doc.RemainingCredit) !== 0 || !doc.Payments?.length) {
      return { state: 'awaiting_payment', evidence: { ...evidence, kind: 'awaiting_recorded_manual_refund',
        instruction: 'Record and bank-reconcile the cash refund against this credit note in Xero. No automatic cash transfer was made.' } };
    }
    if (doc.Allocations?.length) fail('Refund credit note was allocated to an invoice; cash refund plus retained credit is prohibited.');
    let refunded = 0;
    const paymentIds = [];
    if (doc.Payments.length > 25) fail('Refund payment coverage exceeds the safe verification bound.');
    for (const entry of doc.Payments) {
      if (!entry.PaymentID) fail('Manual refund payment identity is missing.');
      if (paymentIds.includes(entry.PaymentID)) fail('Refund has duplicate payment identities.');
      const p = (await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments?.[0];
      if (p?.PaymentID !== entry.PaymentID || p.Status !== 'AUTHORISED' || p.IsReconciled !== true
          || p.CreditNote?.CreditNoteID !== id || !p.Account?.AccountID
          || p.Reference !== `${c.reference}:refund`) fail('Cash refund requires exact-reference bank-reconciled credit-note payment evidence.');
      const amount = amendmentMinor(p.Amount);
      if (amount <= 0) fail('Refund payment amount must be positive.');
      refunded += amount;
      paymentIds.push(p.PaymentID);
    }
    if (refunded !== c.amounts.grossMinor) fail('Recorded cash refund amount differs from the approved adjustment.');
    return { state: 'settled', evidence: { ...evidence, kind: 'recorded_manual_refund', paymentIds, retainedCreditMinor: 0 } };
  }
  async function execute(amendment, settlement) {
    const c = settlement.context;
    if (settlement.choice === 'none') return inspect(amendment, settlement);
    const { provider, request, xeroTenantId } = await client(amendment.tenant_id);
    if (xeroTenantId !== c.xeroTenantId) fail('Accounting connection changed before document creation.');
    if (settlement.choice === 'collect') {
      await provider.createSalesInvoice(amendment.tenant_id, accepted(c));
    } else {
      // Existing generic credit helper recalculates tax from the original
      // invoice and can allocate credit. Use the shared exact sales-line builder
      // with explicit quoted VAT instead; no allocation for a paid purchase.
      const invoice = buildXeroSalesInvoicePayload(accepted(c)).Invoices[0];
      const { DueDate, ...credit } = invoice;
      await request('CreditNotes', { method: 'POST', key: c.reference,
        body: { CreditNotes: [{ ...credit, Type: 'ACCRECCREDIT' }] } });
    }
    return inspect(amendment, settlement);
  }
  return { prepare, execute, inspect, verifyOriginal };
}
