// Task 3339 — per-tier nominal code override for membership invoices.
// Resolution order for the account/nominal code on a membership invoice line:
//   1. Per-tier override (flat config or matched band) surfaced on the
//      simulation result as `nominalCode`.
//   2. Global `membership_nominal_ledger` tenant system setting.
//   3. null — the accounting providers then apply their own defaults
//      (Xero: membership_nominal_ledger -> xero_sales_account_code -> '200';
//      QuickBooks: the configured membership Item).
// Add-on lines carry their own per-line nominal codes and are unaffected.
export async function resolveMembershipNominalCode(supabase, tenantId, simResult) {
  const tierCode = typeof simResult?.nominalCode === 'string' ? simResult.nominalCode.trim() : '';
  if (tierCode) return tierCode;

  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_nominal_ledger')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  const globalCode = (data?.setting_value || '').trim();
  return globalCode || null;
}
