import { normalizeAnnualRenewalConfig, resolveAnnualRenewal, isAnnualNonRecurring } from './annualRenewalPolicy.js';
import { invalidateMemberSessions } from './session.js';
import { getPausedMemberIdSet } from './memberPause.js';
import { isRollingCommitment } from '../../shared/rollingMembershipTerm.js';

async function isTenantAdmin(client, tenantId, member) {
  if (!member?.role_id) return false;
  const { data, error } = await client.from('role')
    .select('id').eq('tenant_id', tenantId).eq('id', member.role_id)
    .eq('is_tenant_admin', true).limit(1);
  if (error) throw new Error(`Could not check tenant administrator protection: ${error.message}`);
  return (data || []).length > 0;
}

export async function hasSuccessfulNextTerm(client, table, tenantId, idColumn, id, history, term) {
  let query = client.from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq(idColumn, id)
    .neq('id', history.id)
    .in('status', ['active', 'scheduled']);
  const nextStart = term.nextStart.toISOString().slice(0, 10);
  query = history.term_key
    ? query.eq('term_start_date', nextStart).eq('previous_term_id', history.id)
    : query.gte('term_start_date', nextStart).limit(1);
  const { data, error } = await query;
  if (error) throw new Error(`Could not check renewed membership: ${error.message}`);
  return (data || []).some((row) =>
    isAnnualPaid(row)
  );
}

function isAnnualPaid(row) {
  return isAnnualNonRecurring(row)
    && (row.term_key ? hasSettledRollingPayment(row)
      : row.payment_status === 'paid' || !!row.paid_at || hasExplicitZeroAmount(row));
}

function validAgreedAmount(row) {
  const amount = row.total_with_vat ?? row.final_cost;
  return amount !== null && amount !== undefined && String(amount).trim() !== ''
    && Number.isFinite(Number(amount)) && Number(amount) >= 0;
}

function hasExplicitZeroAmount(row) {
  return validAgreedAmount(row) && Number(row.total_with_vat ?? row.final_cost) === 0;
}

function hasSettledRollingPayment(row) {
  // Zero-due approval paths durably mark payment_status=paid too. An active
  // or scheduled row alone is not evidence that a free term was approved.
  return isRollingCommitment(row) && !!row.commitment_snapshot && validAgreedAmount(row)
    && (row.payment_status === 'paid' || (!!row.paid_at && Number.isFinite(Date.parse(row.paid_at))));
}

export function isCurrentMembershipProtection(row, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (row.term_key || row.commitment_snapshot?.start_mode === 'immediate') {
    return row.status === 'active' && hasSettledRollingPayment(row)
      && row.term_start_date <= today && today < row.membership_renewal_date;
  }
  // Preserve established fixed-cycle protection rules.
  return ['active', 'scheduled'].includes(row.status) && row.term_end_date >= today;
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
  const paused = await getPausedMemberIdSet(tenantId, client);
  const { data: histories, error } = await client.from('member_membership_history')
    .select('*')
    .eq('tenant_id', tenantId).is('expiry_enforced_at', null);
  if (error) throw new Error(`Could not load member expiry candidates: ${error.message}`);
  let enforced = 0;
  for (const history of histories || []) {
    if (paused.has(history.member_id) || ['cancelled', 'void', 'scheduled'].includes(history.status)) continue;
    const { data: liveConfig, error: configError } = await client.from('membership_tier_config').select('*').eq('id', history.config_id).eq('tenant_id', tenantId).maybeSingle();
    if (configError) throw new Error(`Could not load expiry policy: ${configError.message}`);
    const config = history.commitment_snapshot?.config || liveConfig;
    if (config?.start_mode === 'immediate' && !history.commitment_snapshot) {
      (results?.details || []).push({ tenantId, historyId: history.id, status: 'review_required', reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      continue;
    }
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
      .select('id, tenant_id, identity_id, login_enabled, role_id, organization_id').eq('id', history.member_id).eq('tenant_id', tenantId).maybeSingle();
    if (memberError) throw new Error(`Could not load member expiry candidate: ${memberError.message}`);
    if (!member) continue;
    if (member.organization_id) {
      const { data: inherited, error: inheritedError } = await client.from('organisation_membership_history')
        .select('*').eq('tenant_id', tenantId).eq('organization_id', member.organization_id)
        .eq('status', 'active').lte('term_start_date', now.toISOString().slice(0, 10))
        .gte('term_end_date', now.toISOString().slice(0, 10));
      if (inheritedError) throw new Error(`Could not check inherited membership protection: ${inheritedError.message}`);
      if (inherited?.some(row => isCurrentMembershipProtection(row, now))) continue;
    }
    const outcome = await enforceMemberExpiry(client, tenantId, member, config, history, now);
    if (outcome.enforced) { enforced++; if (results) results.processed++; }
  }
  // Organisation records fan out through their current tenant-scoped members.
  const { data: orgHistories, error: orgError } = await client.from('organisation_membership_history')
    .select('*')
    .eq('tenant_id', tenantId).is('expiry_enforced_at', null);
  if (orgError) throw new Error(`Could not load organisation expiry candidates: ${orgError.message}`);
  for (const history of orgHistories || []) {
    if (['cancelled', 'void', 'scheduled'].includes(history.status)) continue;
    const { data: liveConfig, error: configError } = await client.from('membership_tier_config').select('*').eq('id', history.config_id).eq('tenant_id', tenantId).maybeSingle();
    if (configError) throw new Error(`Could not load expiry policy: ${configError.message}`);
    const config = history.commitment_snapshot?.config || liveConfig;
    if (config?.start_mode === 'immediate' && !history.commitment_snapshot) {
      (results?.details || []).push({ tenantId, historyId: history.id, status: 'review_required', reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      continue;
    }
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
      if (paused.has(member.id)) continue;
      const { data: activeIndividual, error: individualError } = await client.from('member_membership_history')
        .select('*').eq('tenant_id', tenantId).eq('member_id', member.id)
        .in('status', ['active', 'scheduled'])
        .gte('term_end_date', now.toISOString().slice(0, 10));
      if (individualError) throw new Error(`Could not check personal membership protection: ${individualError.message}`);
      if (activeIndividual?.some(row => isCurrentMembershipProtection(row, now))) continue;
      const result = await enforceMemberExpiry(client, tenantId, member, config, history, now, true, 'organisation');
      if (result.enforced) enforced++;
    }
    await client.from('organisation_membership_history').update({
      expiry_enforced_at: now.toISOString(), annual_renewal_state: 'expired',
    }).eq('id', history.id).eq('tenant_id', tenantId).eq('expiry_enforcement_key', key);
  }
  return { enforced };
}