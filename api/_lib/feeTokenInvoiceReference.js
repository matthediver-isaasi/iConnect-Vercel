// Invoice identity belongs to the saved debt, never to the tenant's current provider.
export function invoiceReferenceFromRow(row) {
  if (!row) return null;
  const provider = row.accounting_provider;
  const id = row.accounting_invoice_id;
  if (provider && !['xero', 'quickbooks'].includes(provider)) {
    if (id || row.xero_invoice_id) throw new Error('Unsupported saved invoice provider');
    return null;
  }
  if (id && !provider) throw new Error('Saved invoice has no provider identity');
  if (provider === 'quickbooks' && row.xero_invoice_id) {
    throw new Error('Conflicting saved invoice provider fields require reconciliation');
  }
  if (provider === 'xero' && id && row.xero_invoice_id && String(id) !== String(row.xero_invoice_id)) {
    throw new Error('Conflicting saved invoice identifiers require reconciliation');
  }
  const invoiceId = id || (!provider || provider === 'xero' ? row.xero_invoice_id : null);
  if (!invoiceId) return null;
  return {
    provider: provider || 'xero', invoiceId: String(invoiceId),
    invoiceNumber: row.accounting_invoice_number || row.xero_invoice_number || null,
    onlineInvoiceUrl: row.accounting_online_invoice_url || (provider !== 'quickbooks' ? row.xero_online_invoice_url : null) || null,
  };
}

export function invoiceReferenceColumns(ref) {
  if (!ref) return {};
  if (!['xero', 'quickbooks'].includes(ref.provider) || !ref.invoiceId) throw new Error('Invalid invoice reference');
  return {
    accounting_provider: ref.provider, accounting_invoice_id: ref.invoiceId,
    accounting_invoice_number: ref.invoiceNumber || null, accounting_online_invoice_url: ref.onlineInvoiceUrl || null,
    ...(ref.provider === 'xero' ? {
      xero_invoice_id: ref.invoiceId, xero_invoice_number: ref.invoiceNumber || null,
      xero_online_invoice_url: ref.onlineInvoiceUrl || null,
    } : {}),
  };
}

export async function resolveFeeTokenInvoiceReference(client, token) {
  if (!token.history_record_id) return invoiceReferenceFromRow(token);
  if (!token.tenant_id || (!!token.member_id === !!token.organization_id)) throw new Error('Invalid fee token owner');
  const member = !!token.member_id;
  const { data: history, error } = await client
    .from(member ? 'member_membership_history' : 'organisation_membership_history')
    .select('*').eq('id', token.history_record_id).eq('tenant_id', token.tenant_id)
    .eq(member ? 'member_id' : 'organization_id', token.member_id || token.organization_id)
    .eq('membership_year', token.membership_year).maybeSingle();
  if (error || !history) throw new Error('Could not verify the fee token linked invoice history');
  const linked = invoiceReferenceFromRow(history);
  if (!linked) {
    if (token.accounting_invoice_id || token.xero_invoice_id) throw new Error('Linked history does not confirm the saved invoice');
    return null;
  }
  // Older fee writers put QBO IDs in xero_* columns. Only owned history can
  // disambiguate those rows; never infer QBO from the active connection.
  if (!token.accounting_invoice_id && !token.accounting_provider && token.xero_invoice_id) {
    if (String(token.xero_invoice_id) !== linked.invoiceId) throw new Error('Fee token invoice differs from linked history');
    return linked;
  }
  const saved = invoiceReferenceFromRow(token);
  if (saved && (saved.provider !== linked.provider || saved.invoiceId !== linked.invoiceId)) {
    throw new Error('Fee token invoice differs from linked history');
  }
  return linked;
}