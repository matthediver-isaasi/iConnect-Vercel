import { normalizeSalesInvoiceStatus } from '../../shared/salesContracts.js';

const fail = message => { throw new Error(`Accounting source linkage: ${message}`); };
async function single(query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) fail('source or persisted linkage not found');
  return data;
}

// Replay is accounting-only: never mutate Stripe, purchase status, available
// funds, pending funds or accepted quote economics here.
export async function linkAccountingProductSource({ db, row }) {
  const link = row?.snapshot?.linkage;
  const result = row?.invoice_result;
  if (!row?.tenant_id || !row.source_id || !link || !result?.id
      || !['xero', 'quickbooks'].includes(row.provider)) fail('invalid authority');
  if (row.source_type === 'sales_commercial_sale') {
    if (link.saleId !== row.source_id || !link.quoteVersionId || !link.attemptId || !link.actorId) fail('invalid sale authority');
    const sale = await single(db.from('sales_commercial_sale').select('*')
      .eq('tenant_id', row.tenant_id).eq('id', link.saleId));
    if (sale.quote_version_id !== link.quoteVersionId) fail('accepted sale changed');
    const attempt = await single(db.from('sales_accounting_invoice_attempt').select('*')
      .eq('tenant_id', row.tenant_id).eq('id', link.attemptId));
    if (attempt.sale_id !== link.saleId || attempt.provider !== row.provider) fail('attempt authority mismatch');
    const lookup = () => db.from('sales_accounting_invoice_link').select('*')
      .eq('tenant_id', row.tenant_id).eq('sale_id', link.saleId).eq('provider', row.provider);
    const { data: existing, error: lookupError } = await lookup().maybeSingle();
    if (lookupError) throw lookupError;
    let saved = existing;
    if (!saved) {
      const { data, error } = await db.from('sales_accounting_invoice_link').insert({
        tenant_id: row.tenant_id, sale_id: link.saleId, quote_version_id: link.quoteVersionId,
        provider: row.provider, provider_invoice_id: String(result.id),
        provider_invoice_number: result.number || result.invoiceNumber || null,
        provider_invoice_url: result.url || null,
        provider_status: normalizeSalesInvoiceStatus(result.status),
        provider_status_raw: result.status || null, provider_created_at: result.createdAt || null,
        status_refreshed_at: new Date().toISOString(), created_by: link.actorId,
      }).select('*').single();
      if (error && error.code !== '23505') throw error;
      saved = error ? await single(lookup()) : data;
    }
    if (!saved || saved.provider_invoice_id !== String(result.id)
        || saved.quote_version_id !== link.quoteVersionId) fail('invoice already linked to a different source');
    await single(db.from('sales_accounting_invoice_attempt').update({
      state: 'succeeded', link_id: saved.id, completed_at: new Date().toISOString(),
    }).eq('tenant_id', row.tenant_id).eq('id', link.attemptId)
      .eq('sale_id', link.saleId).eq('provider', row.provider).select('*'));
    return { linked: true, linkId: saved.id };
  }
  if (row.source_type === 'training_fund_purchase') {
    if (link.purchaseId !== row.source_id || !link.organizationId) fail('invalid purchase authority');
    const lookup = () => db.from('training_fund_purchase').select('*')
      .eq('tenant_id', row.tenant_id).eq('id', link.purchaseId).eq('organization_id', link.organizationId);
    const purchase = await single(lookup());
    const invoiceId = purchase.accounting_invoice_id || purchase.xero_invoice_id;
    if (invoiceId && (invoiceId !== result.id || (purchase.accounting_provider && purchase.accounting_provider !== row.provider))) {
      fail('purchase already linked to a different invoice');
    }
    const columns = {
      accounting_provider: row.provider, accounting_invoice_id: result.id,
      accounting_invoice_number: result.invoiceNumber || result.number || null,
      online_invoice_url: result.url || result.onlineInvoiceUrl || null,
      ...(row.provider === 'xero' ? {
        xero_invoice_id: result.id, xero_invoice_number: result.invoiceNumber || result.number || null,
      } : {}),
    };
    if (!invoiceId) {
      const { error } = await db.from('training_fund_purchase').update(columns)
        .eq('tenant_id', row.tenant_id).eq('id', link.purchaseId).eq('organization_id', link.organizationId)
        .is('accounting_invoice_id', null).is('xero_invoice_id', null);
      if (error) throw error;
    }
    const persisted = await single(lookup());
    if ((persisted.accounting_invoice_id || persisted.xero_invoice_id) !== result.id
        || (persisted.accounting_provider && persisted.accounting_provider !== row.provider)) fail('purchase link not persisted');
    return { linked: true, purchaseId: purchase.id };
  }
  fail('unsupported product source');
}