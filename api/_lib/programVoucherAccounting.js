import { randomUUID, createHash } from 'node:crypto';

export function programInvoiceTax(grossMinor, rate, taxCode) {
  if (rate === null || rate === undefined || String(rate).trim() === '' || !taxCode
    || !Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
    throw new Error('Configure an explicit programme VAT rate (including 0 for exempt sales) and matching provider tax code');
  }
  const netMinor = Math.round(grossMinor / (1 + Number(rate) / 100));
  return { rate: Number(rate), taxCode, grossMinor, netMinor, taxMinor: grossMinor - netMinor };
}

export function programAccountingPlan(snapshot) {
  if (!snapshot) throw new Error('Programme accounting snapshot unavailable; reconcile historical purchase');
  const s = snapshot;
  for (const key of ['grossMinor', 'discountMinor', 'remainingMinor', 'trainingFundMinor', 'voucherMinor']) {
    if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw new Error(`Invalid programme ${key}`);
  }
  const allocations = s.allocations || [];
  if (allocations.some(a => !a.id || !a.displayName || !['member', 'organization'].includes(a.ownerType)
    || !Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0)
    || allocations.reduce((sum, a) => sum + a.amountMinor, 0) !== s.voucherMinor
    || s.grossMinor - s.discountMinor !== s.remainingMinor + s.trainingFundMinor + s.voucherMinor) {
    throw new Error('Programme accounting funding does not balance');
  }
  const labels = allocations.map(a => `${a.displayName} (${a.ownerType === 'member' ? 'Personal' : 'Organisation'}): GBP ${(a.amountMinor / 100).toFixed(2)}`);
  return { invoiceMinor: s.grossMinor - s.discountMinor,
    description: `${s.programName}. Gross fees GBP ${(s.grossMinor / 100).toFixed(2)}; discount GBP ${(s.discountMinor / 100).toFixed(2)}. Funding (not discounts): ${labels.join('; ')}; training fund GBP ${(s.trainingFundMinor / 100).toFixed(2)}. Remaining cash liability GBP ${(s.remainingMinor / 100).toFixed(2)}.`,
    payments: [...allocations.map(a => ({ id: a.id, amountMinor: a.amountMinor, kind: 'voucher',
      reference: `${a.ownerType === 'member' ? 'Personal' : 'Organisation'} voucher ${a.id}` })),
    ...(s.trainingFundMinor ? [{ id: 'training', amountMinor: s.trainingFundMinor, kind: 'training_fund', reference: 'Organisation training fund' }] : []),
    ...(s.remainingMinor && s.paymentMethod === 'card' ? [{ id: 'cash', amountMinor: s.remainingMinor, kind: 'cash', reference: `Stripe: ${s.paymentIntentId}` }] : [])] };
}

/** Called both after commit and on the same authenticated purchase-key replay.
 * Accounting failure never refunds or repeats the committed entitlement. */
export async function continueProgramVoucherAccounting(db, tenantId, purchaseKey, deps = {}) {
  const lease = randomUUID();
  const claimed = await db.rpc('claim_program_credit_accounting', {
    p_tenant_id: tenantId, p_purchase_key: purchaseKey, p_lease: lease,
  });
  if (claimed.error) return { status: 'pending', error: 'Programme accounting migration/claim unavailable' };
  const row = claimed.data?.[0];
  if (!row) {
    const saved = await db.from('program_credit_purchase').select('accounting_status,accounting_error,accounting_invoice')
      .eq('tenant_id', tenantId).eq('purchase_key', purchaseKey).single();
    return { status: saved.data?.accounting_status || 'pending', error: saved.error?.message || saved.data?.accounting_error,
      invoice: saved.data?.accounting_invoice };
  }
  const save = async values => {
    const updated = await db.from('program_credit_purchase').update(values).eq('tenant_id', tenantId)
      .eq('purchase_key', purchaseKey).eq('accounting_lease', lease).select('purchase_key').single();
    if (updated.error || !updated.data) throw new Error('Could not persist programme accounting progress');
    Object.assign(row, values);
  };
  try {
    const s = row.accounting_snapshot;
    const plan = programAccountingPlan(s);
    const facade = deps.facade || await import('./accountingProvider.js');
    const provider = row.accounting_provider ? facade.getAccountingProviderByName(row.accounting_provider)
      : await facade.getAccountingProvider(tenantId);
    if (!['xero', 'quickbooks'].includes(provider.name)) throw new Error('Programme accounting provider is not configured');
    // Dedicated revenue and clearing settings are mandatory; never inherit a
    // membership revenue code or silently fall back to a Stripe bank account.
    const setting = async key => {
      const r = await db.from('system_settings').select('setting_value').eq('tenant_id', tenantId).eq('setting_key', key).maybeSingle();
      if (r.error || !r.data?.setting_value) throw new Error(`Configure ${key} before retrying programme accounting`);
      return r.data.setting_value;
    };
    const nominalCode = await setting(provider.name === 'xero' ? 'xero_program_sales_account_code' : 'quickbooks_program_sales_item_id');
    const tax = row.accounting_tax || programInvoiceTax(plan.invoiceMinor,
      await setting('program_price_vat_rate_percent'), await setting(`${provider.name}_program_tax_code`));
    for (const kind of new Set(plan.payments.filter(p => p.kind !== 'cash').map(p => p.kind))) {
      await setting(`${provider.name}_${kind}_clearing_account_${provider.name === 'xero' ? 'code' : 'id'}`);
    }
    const identity = createHash('sha256').update(`${tenantId}:${purchaseKey}`).digest('hex');
    // This namespace enables the providers' durable payment-reference recovery.
    const key = `membership-credit-program:${identity}`;
    if (!row.accounting_invoice) {
      if (row.accounting_attempted_at && Date.now() - Date.parse(row.accounting_attempted_at) > 23 * 3600000) {
        throw new Error('Uncertain invoice creation outcome; reconcile existing invoice before retrying');
      }
      await save({ accounting_provider: provider.name, accounting_tax: tax,
        accounting_attempted_at: row.accounting_attempted_at || new Date().toISOString() });
      const contact = await provider.resolveOrCreateContact({ appTenantId: tenantId,
        contactInfo: { name: s.organizationName, email: s.email } });
      // Checkout price is the amount payable, not a net amount to which tax
      // can be added. Extract inclusive VAT and verify provider readback.
      const invoice = await provider.createSalesInvoice(tenantId, {
        customerId: contact.contactId, currency: s.currency, customerReference: purchaseKey,
        purchaseOrderReference: s.purchaseOrder, idempotencyKey: `program_${identity.slice(0, 40)}`,
        netMinor: tax.netMinor, taxMinor: tax.taxMinor, grossMinor: tax.grossMinor,
        lines: [{ description: plan.description, quantity: '1', accountCode: nominalCode,
          itemId: nominalCode, taxCode: tax.taxCode, netMinor: tax.netMinor, taxMinor: tax.taxMinor, grossMinor: tax.grossMinor }],
      });
      if (!invoice?.id) throw new Error('Gross programme invoice not confirmed');
      await save({ accounting_invoice: { provider: provider.name, invoiceId: invoice.id,
        invoiceNumber: invoice.number, onlineInvoiceUrl: invoice.url } });
    }
    for (const payment of plan.payments) {
      if (row.accounting_steps.includes(payment.id)) continue;
      if (payment.kind === 'cash' && !s.paymentIntentId) throw new Error('Persisted verified card payment is missing');
      const result = await provider.applyStripePaymentToInvoice({
        appTenantId: tenantId, invoiceId: row.accounting_invoice.invoiceId, amount: payment.amountMinor / 100,
        paymentReference: payment.kind === 'cash' ? payment.reference : `Programme ${identity.slice(0, 12)} ${payment.reference}`,
        idempotencyKey: `${key}:${payment.id}`,
        ...(payment.kind === 'cash' ? { stripePaymentIntentId: s.paymentIntentId } : {
          bankAccountSettingKey: `${provider.name}_${payment.kind}_clearing_account_${provider.name === 'xero' ? 'code' : 'id'}`,
          strictBankAccount: true,
        }),
      });
      if (!result?.payment_recorded) throw new Error(`${payment.kind} accounting allocation not confirmed`);
      await save({ accounting_steps: [...row.accounting_steps, payment.id] });
    }
    await save({ accounting_status: 'complete', accounting_error: null, accounting_lease_until: null });
    return { status: 'complete', invoice: row.accounting_invoice };
  } catch (error) {
    await save({ accounting_status: 'pending', accounting_error: error.message, accounting_lease_until: null });
    return { status: 'pending', error: error.message, invoice: row.accounting_invoice };
  }
}
