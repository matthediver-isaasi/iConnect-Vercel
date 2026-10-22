/** No OAuth credentials leave this resolver or enter the purchase snapshot. */
export async function readMembershipAccountingBinding(db, tenantId, provider) {
  if (!['xero', 'quickbooks'].includes(provider)) throw new Error('Membership accounting provider is not configured');
  const result = await db.from(provider === 'xero' ? 'xero_token' : 'quickbooks_token')
    .select(provider === 'xero' ? 'id,tenant_id' : 'id,realm_id,environment')
    .eq('app_tenant_id', tenantId).single();
  const companyId = provider === 'xero' ? result.data?.tenant_id : result.data?.realm_id;
  if (result.error || !result.data?.id || !companyId || companyId === 'PENDING_SELECTION') {
    throw new Error('A selected accounting company is required before membership funding accounting');
  }
  return { provider, connectionId: String(result.data.id), companyId: String(companyId),
    environment: provider === 'quickbooks' ? result.data.environment || 'production' : null };
}

export async function pinMembershipAccountingBinding(db, settlement, provider, deps = {}) {
  const binding = await (deps.resolveBinding || readMembershipAccountingBinding)(db, settlement.tenant_id, provider);
  const { data, error } = await db.rpc('membership_voucher_pin_accounting', {
    p_tenant_id: settlement.tenant_id, p_settlement_id: settlement.id, p_binding: binding,
  });
  if (error) throw new Error(error.message);
  if (!data?.accounting_binding) throw new Error('Accounting company binding was not durably confirmed');
  settlement.accounting_binding = data.accounting_binding;
  return expectedMembershipAccountingContext(data.accounting_binding);
}

export function expectedMembershipAccountingContext(binding) {
  return binding.provider === 'xero' ? { xero_tenant_id: binding.companyId }
    : { quickbooks_realm_id: binding.companyId, environment: binding.environment };
}
