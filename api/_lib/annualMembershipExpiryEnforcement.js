import { normalizeAnnualRenewalConfig, resolveAnnualRenewal } from './annualRenewalPolicy.js';
import { invalidateMemberSessions } from './session.js';

async function isTenantAdmin(client, tenantId, member) {
  if (!member?.role_id) return false;
  const { data, error } = await client.from('role')
    .select('id').eq('tenant_id', tenantId).eq('id', member.role_id)
    .eq('is_tenant_admin', true).limit(1);
  if (error) throw new Error(`Could not check tenant administrator protection: ${error.message}`);
  return (data || []).length > 0;
}

async function hasSuccessfulNextTerm(client, table, tenantId, idColumn, id, history, term) {
  const { data, error } = await client.from(table)
    .select('id, payment_status, paid_at, final_cost, total_with_vat, billing_period')
    .eq('tenant_id', tenantId)
    .eq(idColumn, id)
    .neq('id', history.id)
    .gte('term_start_date', term.nextStart.toISOString().slice(0, 10))
    .in('status', ['active', 'scheduled'])
    .limit(1);
  if (error) throw new Error(`Could not check renewed membership: ${error.message}`);
  return (data || []).some((row) =>
    isAnnualPaid(row)
  );
}

function isAnnualPaid(row) {
  return row.billing_period === 'annual'
    && (row.payment_status === 'paid' || !!row.paid_at
      || Number(row.total_with_vat ?? row.final_cost ?? 0) <= 0);
}

async function enforceMemberExpiry(client, tenantId, member, config, history, now, skipHistoryClaim = false, historyType = 'member') {
  const policy = normalizeAnnualRenewalConfig(config);
  if ((!policy.disableLogin && !policy.changeRole) || await isTenantAdmin(client, tenantId, member)) return { skipped: true };
  const key = `annual-expiry:${history.id}:${history.term_end_date}`;
  if (!skipHistoryClaim) {
    const { data: claimed, error: claimError } = await client.from('member_membership_history')
      .update({ expiry_enforcement_key: key }).eq('id', history.id).eq('tenant_id', tenantId)
      .is('expiry_enforcement_key', null).select('id');
    if (claimError) throw new Error(`Could not claim annual expiry enforcement: ${claimError.message}`);
    if (!claimed?.length) {
      const { data: existingClaim } = await client.from('member_membership_history')
        .select('expiry_enforcement_key, expiry_enforced_at').eq('id', history.id).eq('tenant_id', tenantId).maybeSingle();
      if (existingClaim?.expiry_enforced_at || existingClaim?.expiry_enforcement_key !== key) {
        return { skipped: true, idempotent: true };
      }
    }
  }

  // A false login_enabled is an existing manual/system restriction; never
  // re-enable it and never overwrite its role simply because a sweep ran.
  const update = {};
  if (policy.disableLogin && member.login_enabled !== false) update.login_enabled = false;
  if (policy.changeRole && policy.fallbackRoleId) update.role_id = policy.fallbackRoleId;
  if (Object.keys(update).length) {
    const { error } = await client.from('member').update(update).eq('id', member.id).eq('tenant_id', tenantId);
    if (error) throw new Error(`Could not enforce member expiry: ${error.message}`);
  }
  const { error: auditError } = await client.from('membership_expiry_action').upsert({
    tenant_id: tenantId,
    history_type: historyType,
    history_id: history.id,
    member_id: member.id,
    config_id: history.config_id,
    previous_login_enabled: member.login_enabled,
    login_disabled: policy.disableLogin && member.login_enabled !== false,
    previous_role_id: member.role_id,
    assigned_role_id: policy.changeRole ? policy.fallbackRoleId : null,
    applied_at: now.toISOString(),
    details: { source: 'annual_membership_expiry_sweep' },
  }, { onConflict: 'history_type,history_id,member_id' });
  if (auditError) throw new Error(`Could not record annual expiry provenance: ${auditError.message}`);
  if (policy.disableLogin) {
    const invalidation = await invalidateMemberSessions(member.id);
    if (!invalidation?.success) throw new Error(`Could not invalidate sessions for expired member ${member.id}`);
  }
  if (!skipHistoryClaim) {
    const { error: markError } = await client.from('member_membership_history')
      .update({ expiry_enforced_at: now.toISOString(), annual_renewal_state: 'expired' })
      .eq('id', history.id).eq('tenant_id', tenantId).eq('expiry_enforcement_key', key);
    if (markError) throw new Error(`Could not audit annual expiry enforcement: ${markError.message}`);
  }
  return { enforced: true, memberId: member.id };
}

export async function processTenantAnnualExpirySweep(client, tenantId, results = null, now = new Date()) {
  const { data: histories, error } = await client.from('member_membership_history')
    .select('id, tenant_id, member_id, config_id, billing_period, membership_year, term_start_date, term_end_date, expiry_enforced_at, expiry_enforcement_key')
    .eq('tenant_id', tenantId).is('expiry_enforced_at', null);
  if (error) throw new Error(`Could not load member expiry candidates: ${error.message}`);
  let enforced = 0;
  for (const history of histories || []) {
    const { data: config, error: configError } = await client.from('membership_tier_config').select('*').eq('id', history.config_id).maybeSingle();
    if (configError) throw new Error(`Could not load expiry policy: ${configError.message}`);
    const lifecycle = await resolveAnnualRenewal(client, { tenantId, history, config, now });
    if (!lifecycle.applicable || lifecycle.state !== 'expired'
      || (!lifecycle.policy.disableLogin && !lifecycle.policy.changeRole)) continue;
    if (await hasSuccessfulNextTerm(client, 'member_membership_history', tenantId, 'member_id', history.member_id, history, lifecycle.term)) {
      await client.from('member_membership_history').update({
        expiry_enforced_at: now.toISOString(), annual_renewal_state: 'renewed',
      }).eq('id', history.id).eq('tenant_id', tenantId).is('expiry_enforced_at', null);
      continue;
    }
    const { data: member, error: memberError } = await client.from('member')
      .select('id, tenant_id, identity_id, login_enabled, role_id').eq('id', history.member_id).eq('tenant_id', tenantId).maybeSingle();
    if (memberError) throw new Error(`Could not load member expiry candidate: ${memberError.message}`);
    if (!member) continue;
    const outcome = await enforceMemberExpiry(client, tenantId, member, config, history, now);
    if (outcome.enforced) { enforced++; if (results) results.processed++; }
  }
  // Organisation records fan out through their current tenant-scoped members.
  const { data: orgHistories, error: orgError } = await client.from('organisation_membership_history')
    .select('id, tenant_id, organization_id, config_id, billing_period, membership_year, term_start_date, term_end_date, expiry_enforced_at, expiry_enforcement_key')
    .eq('tenant_id', tenantId).is('expiry_enforced_at', null);
  if (orgError) throw new Error(`Could not load organisation expiry candidates: ${orgError.message}`);
  for (const history of orgHistories || []) {
    const { data: config } = await client.from('membership_tier_config').select('*').eq('id', history.config_id).maybeSingle();
    const lifecycle = await resolveAnnualRenewal(client, { tenantId, history, config, now });
    if (!lifecycle.applicable || lifecycle.state !== 'expired'
      || (!lifecycle.policy.disableLogin && !lifecycle.policy.changeRole)) continue;
    if (await hasSuccessfulNextTerm(client, 'organisation_membership_history', tenantId, 'organization_id', history.organization_id, history, lifecycle.term)) {
      await client.from('organisation_membership_history').update({
        expiry_enforced_at: now.toISOString(), annual_renewal_state: 'renewed',
      }).eq('id', history.id).eq('tenant_id', tenantId).is('expiry_enforced_at', null);
      continue;
    }
    const key = `annual-expiry:${history.id}:${history.term_end_date}`;
    const { data: claimed, error: claimError } = await client.from('organisation_membership_history')
      .update({ expiry_enforcement_key: key }).eq('id', history.id).eq('tenant_id', tenantId)
      .is('expiry_enforcement_key', null).select('id');
    if (claimError) throw new Error(`Could not claim organisation expiry enforcement: ${claimError.message}`);
    if (!claimed?.length) {
      const { data: existingClaim } = await client.from('organisation_membership_history')
        .select('expiry_enforcement_key, expiry_enforced_at').eq('id', history.id).eq('tenant_id', tenantId).maybeSingle();
      if (existingClaim?.expiry_enforced_at || existingClaim?.expiry_enforcement_key !== key) continue;
    }
    const { data: members, error: membersError } = await client.from('member').select('id, tenant_id, identity_id, login_enabled, role_id')
      .eq('tenant_id', tenantId).eq('organization_id', history.organization_id);
    if (membersError) throw new Error(`Could not fan out organisation expiry: ${membersError.message}`);
    for (const member of members || []) {
      const { data: activeIndividual } = await client.from('member_membership_history')
        .select('id').eq('tenant_id', tenantId).eq('member_id', member.id)
        .in('status', ['active', 'scheduled'])
        .gte('term_end_date', now.toISOString().slice(0, 10)).limit(1);
      if (activeIndividual?.length) continue;
      const result = await enforceMemberExpiry(client, tenantId, member, config, history, now, true, 'organisation');
      if (result.enforced) enforced++;
    }
    await client.from('organisation_membership_history').update({
      expiry_enforced_at: now.toISOString(), annual_renewal_state: 'expired',
    }).eq('id', history.id).eq('tenant_id', tenantId).eq('expiry_enforcement_key', key);
  }
  return { enforced };
}