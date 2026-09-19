// Read-only presentation evidence. Never changes entitlement or authorises a
// collection: the persisted plan lifecycle and collection fences remain authoritative.
export async function loadMigratedMandatePresentation(db, plan) {
  if (!plan) return plan;
  const terms = plan.membership_billing_agreements?.metadata?.dd;
  if (plan.provider !== 'gocardless'
      || terms?.billing_request_mode !== 'migration_existing_mandate') return plan;
  if (!plan.tenant_id || !plan.gocardless_mandate_id || !plan.environment) return plan;
  const { data: mandate, error } = await db.from('gocardless_mandates')
    .select('tenant_id, gocardless_mandate_id, environment, status')
    .eq('tenant_id', plan.tenant_id)
    .eq('gocardless_mandate_id', plan.gocardless_mandate_id)
    .eq('environment', plan.environment).maybeSingle();
  if (error) throw error;
  if (!mandate || mandate.tenant_id !== plan.tenant_id
      || mandate.gocardless_mandate_id !== plan.gocardless_mandate_id
      || mandate.environment !== plan.environment) return plan;
  return { ...plan, migratedMandateStatus: mandate.status };
}

export function migratedMandatePresentation(plan) {
  if (!plan) return null;
  const terms = plan.membership_billing_agreements?.metadata?.dd;
  if (plan.provider !== 'gocardless'
      || terms?.billing_request_mode !== 'migration_existing_mandate'
      || plan.migratedMandateStatus !== 'active') return null;
  const awaiting = terms.activation_rule === 'first_payment'
    && ['payment_setup_required', 'mandate_pending', 'first_payment_pending'].includes(plan.status);
  return {
    mandateStatus: 'active',
    awaitingFirstPayment: awaiting,
    collectionHeld: !!plan.collection_stopped_at || plan.metadata?.bnms_release_required === true,
    label: awaiting ? 'Awaiting first payment' : null,
  };
}