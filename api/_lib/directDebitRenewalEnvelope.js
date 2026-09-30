// Read-only envelope evidence, not a second implementation of the durable
// renewal runner. The protected singleton state is accessible only after the
// live claim RPC; preview must never acquire it.
export async function runRenewalEnvelope({ db, plan, now, trace }) {
  const tenantId = plan.tenant_id;
  const setting = await db.from('system_settings').select('setting_value')
    .eq('setting_key', 'membership_cron_time').eq('tenant_id', tenantId)
    .order('setting_value').limit(1).maybeSingle();
  if (setting.error) throw new Error(`Could not read renewal scheduled hour: ${setting.error.message}`);
  const value = String(setting.data?.setting_value ?? '');
  const hour = /^([01]?[0-9]|2[0-3])(:[0-5][0-9])?$/.test(value) ? Number(value.split(':')[0]) : 6;
  const hourReached = now.getUTCHours() >= hour;
  let candidate = false;
  for (const [table, field] of [
    ['membership_tier_config', 'effective_to'],
    ['member_membership_history', 'expiry_enforced_at'],
    ['organisation_membership_history', 'expiry_enforced_at'],
  ]) {
    const result = await db.from(table).select('id').eq('tenant_id', tenantId).is(field, null).limit(1);
    if (result.error) throw new Error(`Could not read renewal discovery evidence: ${result.error.message}`);
    if (result.data?.length) { candidate = true; break; }
  }
  trace({
    stage: 'renewal-runner-envelope', status: 'unknown', evidenceAt: now.toISOString(), operations: [],
    reason: `Tenant scheduled hour is ${String(hour).padStart(2, '0')}:00 UTC; the current UTC hour ${hourReached ? 'has reached' : 'has not reached'} that threshold. `
      + `${candidate ? 'Current rows meet' : 'Current rows do not meet'} the tenant-discovery predicate (an open-ended tier configuration or history awaiting expiry enforcement); the runner also retains previously discovered tenants. `
      + 'Actual billing eligibility remains unknown: membership_renewal_cron_tenants discovery and the protected membership_renewal_cron_state billing opportunity/date, done flag, stage and row cursor are not acquired or advanced. '
      + 'A new daily billing opportunity is registered only at/after the scheduled hour if absent, or if an older opportunity is done. A pending opportunity can resume even before today’s scheduled hour; an already-done opportunity for today does not rerun. '
      + 'Owner activation, annual renewals, Direct Debit renewals and reminders below are conditional on a registered, unfinished billing opportunity and its current stage/cursor. Pause restart is a separate pre-billing pass; annual expiry is a separate discovered-tenant pass, not gated by the billing hour/done flag. All passes still require the live lease, discovery and budget.',
  });
}