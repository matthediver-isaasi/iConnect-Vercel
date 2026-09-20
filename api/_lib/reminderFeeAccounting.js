import { getAccountingProvider, getAccountingProviderByName } from './accountingProvider.js';
import { invoiceReferenceFromRow, invoiceReferenceColumns } from './feeTokenInvoiceReference.js';
import { accountingOperationIdentity } from './accountingOperationIdentity.js';

// Browser confirmation and Stripe recovery share this journal. No journal row
// means creation is known not to have been attempted; finish local preflight
// before inserting one. A row without invoice identity means creation may have
// been attempted (including a crash immediately after claiming): retries only
// discover the exact PI marker through the originally selected provider.
export async function completeReminderFeeAccounting({ client, token, history, paymentIntent }, deps = {}) {
  const table = token.member_id ? 'member_membership_history' : 'organisation_membership_history';
  const tenantId = token.tenant_id;
  let reference = invoiceReferenceFromRow(history);
  const getProvider = deps.getProvider || getAccountingProvider;
  const byName = deps.getProviderByName || getAccountingProviderByName;
  let provider, journal;
  if (!reference) {
    const { data: prior, error: readError } = await client.from('membership_reminder_accounting')
      .select('*').eq('tenant_id', tenantId).eq('history_record_id', history.id).maybeSingle();
    if (readError) throw new Error(readError.message);
    journal = prior;
    if (!journal) {
      provider = await getProvider(tenantId);
      if (!['xero', 'quickbooks'].includes(provider.name)) throw new Error('No accounting provider configured for renewal invoice');
      if (typeof provider.createMembershipInvoice !== 'function') throw new Error('Renewal invoice creation is unavailable');
      const cb = token.cost_breakdown || {};
      const config = cb.renewalQuote?.config;
      const { data: owner, error: ownerError } = await client.from(token.member_id ? 'member' : 'organization')
        .select('*').eq('id', token.member_id || token.organization_id).eq('tenant_id', tenantId).maybeSingle();
      if (ownerError || !owner) throw new Error('Renewal invoice owner could not be loaded');
      const addons = cb.addonLines || [];
      const addonNet = addons.reduce((sum, line) => sum + Number(line.line_total || 0), 0);
      const { resolveInvoiceAddress } = await import('./invoiceAddressResolver.js');
      const invoiceArgs = {
        appTenantId: tenantId,
        organizationName: owner.name || [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.email,
        invoicingEmail: owner.invoicing_email || owner.email || null,
        invoicingAddress: await (deps.resolveInvoiceAddress || resolveInvoiceAddress)(client, config, owner.id, token.member_id ? 'member' : 'organization'),
        membershipYear: token.membership_year, tierLabel: token.tier_label,
        finalCost: Math.round((Number(token.final_cost) - addonNet) * 100) / 100,
        currency: token.currency,
        reference: `Membership ${token.membership_year}${token.po_number ? ` - PO: ${token.po_number}` : ''}`,
        vatRate: cb.taxType || cb.matchedBand?.vat_rate || null,
        nominalCode: cb.nominalCode || config?.nominal_code || null,
        invoiceDescription: config?.invoice_description || null,
        extraLineItems: addons.map(line => ({
          description: line.description, nominalCode: line.nominal_code || null,
          vatRate: line.vat_rate || null, quantity: Number(line.quantity) || 1,
          unitCost: Number(line.line_total) / (Number(line.quantity) || 1),
        })),
        markAsPaid: false, deferStripeSettlement: true,
        stripePaymentIntentId: paymentIntent.id,
        idempotencyKey: accountingOperationIdentity(`${tenantId}:${history.id}`, 'rninv', 50),
      };
      // The unique claim is the boundary between safe preflight retries and
      // possibly remote effects. Do not perform fallible local work after it,
      // or delete it when create throws: a thrown response can hide a success.
      const { data, error } = await client.from('membership_reminder_accounting').insert({
        tenant_id: tenantId, history_record_id: history.id, provider: provider.name,
        stripe_payment_intent_id: paymentIntent.id,
      }).select('*').maybeSingle();
      if (error) {
        if (error.code === '23505') throw new Error('Renewal invoice is being prepared by another callback; retry shortly');
        throw new Error(error.message);
      }
      journal = data;
      if (!journal) throw new Error('Renewal invoice creation claim unavailable');
      const created = await provider.createMembershipInvoice(invoiceArgs);
      if (!created?.invoiceId && !created?.invoice_id) throw new Error('Renewal invoice creation was not confirmed');
      reference = { provider: provider.name, invoiceId: created.invoiceId || created.invoice_id,
        invoiceNumber: created.invoiceNumber || created.invoice_number || null,
        onlineInvoiceUrl: created.onlineInvoiceUrl || created.online_invoice_url || null };
    } else {
      if (journal.stripe_payment_intent_id !== paymentIntent.id) throw new Error('Renewal invoice claim belongs to another Stripe payment');
      provider = byName(journal.provider);
      reference = invoiceReferenceFromRow(journal);
      if (!reference) {
        const found = await provider.findFormStripeInvoice({ appTenantId: tenantId,
          stripePaymentIntentId: paymentIntent.id, createdAfter: journal.created_at });
        if (!found?.invoiceId && !found?.invoice_id) throw new Error('Renewal invoice creation remains unconfirmed; no duplicate invoice was attempted');
        reference = { provider: journal.provider, invoiceId: found.invoiceId || found.invoice_id,
          invoiceNumber: found.invoiceNumber || found.invoice_number || null,
          onlineInvoiceUrl: found.onlineInvoiceUrl || found.online_invoice_url || null };
      }
    }
    const { error } = await client.from('membership_reminder_accounting')
      .update(invoiceReferenceColumns(reference)).eq('tenant_id', tenantId).eq('history_record_id', history.id);
    if (error) throw new Error(error.message);
  }
  provider ||= byName(reference.provider);
  // Persist identity before applying payment so a crash is repairable without
  // another invoice create, even when the browser never returns.
  for (const [target, id] of [[table, history.id], ['membership_fee_token', token.id]]) {
    const { error } = await client.from(target).update(invoiceReferenceColumns(reference))
      .eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
  }
  const applied = await provider.applyStripePaymentToInvoice({
    appTenantId: tenantId, invoiceId: reference.invoiceId, xeroInvoiceId: reference.invoiceId,
    stripePaymentIntentId: paymentIntent.id,
    idempotencyKey: accountingOperationIdentity(`${tenantId}:${paymentIntent.id}`, 'rnpay', 50),
  });
  if (!applied || applied.payment_recorded === false || applied.raw?.payment_recorded === false) {
    throw new Error('Renewal invoice payment was not confirmed');
  }
  return { reference, invoice: applied, payment_recorded: true };
}