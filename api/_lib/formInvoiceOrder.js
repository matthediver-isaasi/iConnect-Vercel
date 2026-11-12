import { getActiveAccountingProvider } from './accountingProvider.js';
import { accountingQueueEnabled, resolveAccountingQueueBinding } from './accountingQueueIntegration.js';
import { freezeMembershipPreparation, prepareMembershipSourceRequest } from './accountingSourcePreparation.js';
import { listCatalogueTaxOptions } from './salesCatalogueTaxOptions.js';
import { resolveFormCart } from './formCart.js';
import { buildXeroSalesInvoiceLine } from './xero.js';
import { isDeepStrictEqual } from 'node:util';
import { cartAccountingSettings } from '../../shared/formCartAccounting.js';
import { membershipProjectTracking } from '../../shared/membershipProjectCode.js';

export const FORM_INVOICE_SOURCE = 'form_invoice_order';
// This object is supplied only by the server payment handler, never req.body.
export const invoiceOrderAuthority = Symbol('invoiceOrderAuthority');
const fail = (message, code = 'FORM_INVOICE_UNAVAILABLE', status = 409) => {
  throw Object.assign(new Error(message), { code, status });
};

export async function formInvoiceReady(db) {
  if (!accountingQueueEnabled()) return false;
  const { data, error } = await db.rpc('form_invoice_order_version');
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) return false;
    throw error;
  }
  return data === 1;
}

export function invoiceBillingDetails(field, fields, values) {
  const value = (id, allowed) => {
    const source = fields.find(f => f.id === id && allowed.includes(f.type));
    const answer = source && values[source.id];
    return typeof answer === 'string' ? answer.trim() : '';
  };
  const name = value(field.invoice_billing_name_field_id, ['text', 'short_text', 'full_name']);
  const email = value(field.invoice_billing_email_field_id, ['email']);
  if (!name || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    fail('Enter the billing name and email address before requesting an invoice.', 'INVOICE_BILLING_REQUIRED', 400);
  }
  const address = field.invoice_address_field_id ? values[field.invoice_address_field_id] : null;
  if (address != null && typeof address !== 'string') {
    fail('Use a Text or Long text field for the invoice address.', 'INVOICE_ADDRESS_INVALID', 400);
  }
  return { name, email, address: typeof address === 'string' ? address.slice(0, 2000) : null };
}

export function invoiceLines({ cartTerms, amount, label, taxOptions, defaultCode, accountCode, projectCode }) {
  if (!accountCode) fail('Set the accounting sales account before enabling invoice checkout.');
  if (cartTerms) {
    return cartTerms.lines.map(line => {
      const matches = taxOptions.filter(code => code.rateBps === line.taxRateBps);
      const code = matches.length === 1 ? matches[0] : null;
      if (!code) fail('The cart tax rate needs an unambiguous accounting tax code before invoice checkout.');
      return { description: line.name, quantity: line.quantity,
        netMinor: line.netMinor, taxMinor: line.taxMinor, grossMinor: line.grossMinor,
        taxCode: code.id, accountCode, ...(projectCode ? { projectCode } : {}) };
    });
  }
  const code = taxOptions.find(code => code.id === defaultCode);
  if (!code) fail('Select a default sales tax code in accounting settings before invoice checkout.');
  const grossMinor = Math.round(amount * 100);
  const netMinor = Math.round(grossMinor * 10000 / (10000 + code.rateBps));
  return [{ description: label, quantity: 1, netMinor, taxMinor: grossMinor - netMinor, grossMinor,
    taxCode: code.id, accountCode }];
}

export async function prepareFormInvoiceOrder({ db, tenantId, form, field, values, amount, currency, membershipMeta }) {
  if (membershipMeta) fail('Pay by invoice on this field is for ordinary orders, not membership schedule payments.');
  if (form.fields?.some(f => f.type === 'sales_bundle')) {
    fail('Use a Cart field for bundle orders paid by invoice.');
  }
  if (!await formInvoiceReady(db)) fail('Invoice checkout requires the accounting queue and database update.', undefined, 503);
  // Other accounting providers retain their existing flows until this source
  // has an exact, tested payload adapter for them.
  if (await getActiveAccountingProvider(tenantId) !== 'xero') fail('Invoice checkout requires a connected Xero account.');
  const binding = await resolveAccountingQueueBinding({ db, tenantId, provider: 'xero' });
  const billing = invoiceBillingDetails(field, form.fields || [], values);
  const taxes = await listCatalogueTaxOptions(db, tenantId);
  const { data: settings, error } = await db.from('system_settings').select('setting_key,setting_value')
    .eq('tenant_id', tenantId).in('setting_key', ['xero_sales_account_code']);
  if (error) throw error;
  const { data: sales, error: salesError } = await db.from('sales_settings')
    .select('default_product_tax_code').eq('tenant_id', tenantId).maybeSingle();
  if (salesError) throw salesError;
  const cart = await resolveFormCart(db, form, values);
  let accounting;
  try {
    accounting = cartAccountingSettings(form, values);
  } catch (error) {
    fail(error.message, 'CART_ACCOUNTING_INVALID', 400);
  }
  const lines = invoiceLines({
    cartTerms: cart || null, amount, label: field.payment_label || form.name,
    taxOptions: taxes.items, defaultCode: sales?.default_product_tax_code?.id,
    accountCode: accounting?.nominalCode || settings?.find(s => s.setting_key === 'xero_sales_account_code')?.setting_value,
    projectCode: accounting?.projectCode,
  });
  const totalMinor = lines.reduce((sum, line) => sum + line.grossMinor, 0);
  if (totalMinor !== Math.round(amount * 100)) fail('Invoice total changed. Refresh the payment summary.');
  const invoice = await freezeMembershipPreparation({ db, totalMinor, args: {
    appTenantId: tenantId, organizationName: billing.name, invoicingEmail: billing.email,
    invoicingAddress: billing.address, finalCost: amount, currency,
    invoiceDescription: field.payment_label || form.name, reference: accounting?.reference ?? form.name,
    ...(accounting ? { nominalCode: accounting.nominalCode, xeroProjectCode: accounting.projectCode } : {}),
  } });
  return {
    version: 1, provider: binding.provider, connectionId: binding.connectionId, companyId: binding.companyId,
    amount, currency, snapshot: {
      version: 1, preparation: true, invoice, payment: null,
      linkage: { formId: form.id }, lines,
    },
  };
}

export async function assertFormInvoiceSource({ db, row }) {
  const { data, error } = await db.from('form_submission').select('id,form_id,payment_provider,payment_meta,payment_amount,payment_currency')
    .eq('tenant_id', row.tenant_id).eq('id', row.source_id).maybeSingle();
  const authority = data?.payment_meta?.invoice_order;
  if (error || !data || data.payment_provider !== 'invoice' || authority?.version !== 1
    || data.form_id !== row.snapshot.linkage.formId
    || authority.provider !== row.provider || authority.companyId !== row.company_id
    || authority.connectionId !== row.connection_id || authority.amount !== Number(data.payment_amount)
    || authority.currency !== data.payment_currency || !isDeepStrictEqual(authority.snapshot, row.snapshot)) {
    fail('Invoice order authority changed.', 'FORM_INVOICE_AUTHORITY_CHANGED');
  }
  return data;
}

export async function isConfirmedFormInvoice(db, submission) {
  if (submission?.payment_provider !== 'invoice' || submission.payment_status !== 'unpaid'
    || submission.payment_meta?.invoice_order?.version !== 1) return false;
  const { data, error } = await db.from('accounting_request_queue').select('*')
    .eq('tenant_id', submission.tenant_id).eq('source_type', FORM_INVOICE_SOURCE)
    .eq('source_id', submission.id).eq('operation', 'invoice').maybeSingle();
  if (error) throw error;
  if (!data) return false;
  await assertFormInvoiceSource({ db, row: data });
  return true;
}

export async function prepareFormInvoiceSource({ row, transport }, dependencies = {}) {
  // Reuse the fenced contact-resolution preparation, never the membership
  // finalizer. Replace its single line with our frozen ordinary-order lines.
  const prepared = await prepareMembershipSourceRequest({ row, transport }, dependencies);
  const envelope = prepared.invoice.envelope;
  const payload = { ...envelope.payload, Status: 'AUTHORISED', LineAmountTypes: 'Exclusive',
    LineItems: row.snapshot.lines.map(line => ({
      ...buildXeroSalesInvoiceLine(line), ...membershipProjectTracking(line.projectCode),
    })) };
  // Keep the already-created stable recovery marker without appending another.
  const totalMinor = row.snapshot.lines.reduce((sum, line) => sum + line.grossMinor, 0);
  prepared.invoice.envelope = { ...envelope, payload, expected: {
    ...envelope.expected, totalMinor,
    fields: { ...envelope.expected.fields, Type: payload.Type, Status: payload.Status,
      LineAmountTypes: payload.LineAmountTypes, LineItems: payload.LineItems },
  } };
  return prepared;
}

export async function linkFormInvoiceSource({ db, row }) {
  const source = await assertFormInvoiceSource({ db, row });
  if (!row.invoice_result?.id) fail('Invoice result is missing.');
  const { data, error } = await db.from('form_submission').update({
    payment_meta: { ...source.payment_meta, invoice_result: row.invoice_result },
  }).eq('tenant_id', row.tenant_id).eq('id', row.source_id)
    .eq('payment_meta', source.payment_meta).select('id').maybeSingle();
  if (error || !data) throw error || new Error('Invoice linkage changed; retry required.');
  return { linked: true };
}
