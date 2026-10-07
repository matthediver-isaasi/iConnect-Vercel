import { normalizeAnnualRenewalConfig, resolveAnnualRenewal, isAnnualNonRecurring } from './annualRenewalPolicy.js';
import { isRollingCommitment } from '../../shared/rollingMembershipTerm.js';
import { isAttestedExpiryOnlyHistory, loadExpiryOnlyRenewalPolicy, prepareExpiryOnlyRenewalPolicies,
  expiryOnlyPolicyConfig, expiryOnlyLifecycle } from './expiryOnlyRenewalPolicy.js';

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

// A recurring successor belongs to its own activation/collection lifecycle.
// The imported predecessor's expiry policy must not revoke a successfully
// activated renewal. An election or authorised mandate alone is insufficient.
async function isElectedExpiryOnlyRecurringSuccessor(client, tenantId, history, row, now, read) {
  if (!isAttestedExpiryOnlyHistory(history, tenantId) || !row.billing_agreement_id
      || !row.membership_successor_election_id || row.tenant_id !== tenantId
      || row.member_id !== history.member_id || row.organization_id
      || row.status !== 'active' || !isRollingCommitment(row)
      || !row.commitment_snapshot || !validAgreedAmount(row)) return false;
  const today = now.toISOString().slice(0, 10);
  const next = new Date(`${history.term_end_date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (row.term_start_date !== next.toISOString().slice(0, 10)
      || row.term_start_date > today || row.term_end_date < today) return false;
  const settled = hasSettledRollingPayment(row);
  // Both DD and monthly card record 'partial' only after confirmed payment.
  // Do not treat arbitrary paid_at text, scheduled activation or unpaid setup
  // as proof that the recurring membership has successfully begun.
  if (!settled && !(row.payment_status === 'partial'
      && Number(row.total_with_vat ?? row.final_cost) > 0)) return false;
  const election = await read(() => client.from('membership_successor_election').select('*')
    .eq('tenant_id', tenantId).eq('member_id', history.member_id)
    .eq('id', row.membership_successor_election_id).maybeSingle(),
  'Could not verify expiry-only successor election');
  if (!election || election.organization_id || election.status !== 'reserved'
      || election.origin !== 'form' || election.previous_term_id !== history.id
      || election.term_start_date !== row.term_start_date || election.term_end_date !== row.term_end_date
      || !['direct_debit', 'monthly_card'].includes(election.payment_method)) return false;
  const agreement = await read(() => client.from('membership_billing_agreements').select('*')
    .eq('tenant_id', tenantId).eq('member_id', history.member_id)
    .eq('id', row.billing_agreement_id).maybeSingle(),
  'Could not verify expiry-only successor agreement');
  return !!agreement && !agreement.organization_id
    && agreement.membership_successor_election_id === election.id
    && agreement.term_start_date === row.term_start_date && agreement.term_end_date === row.term_end_date
    && agreement.provider === (election.payment_method === 'direct_debit' ? 'gocardless' : 'stripe')
    && (agreement.status === 'active' || (settled && agreement.status === 'completed'));
}

const PAGE_SIZE = 100;
const MEMBER_FIELDS = 'id, tenant_id, identity_id, login_enabled, role_id, organization_id, membership_paused';
const TABLES = { member: 'member_membership_history', organisation: 'organisation_membership_history' };

// Live capability is constructed by the cron with its injected DB/session
// dispatcher. The preview passes only a recording effect capability.
export function annualExpiryEffects(client, invalidateSessions) {
  return { async perform(operation) {
    const p = operation.payload;
    if (operation.type === 'owner.expiry_sessions') {
      if (!invalidateSessions) throw new Error('Expiry session capability is not configured');
      return invalidateSessions(p.memberId);
    }
    if (!['owner.expiry_insert', 'owner.expiry_update'].includes(operation.type)) throw new Error(`Unknown expiry operation: ${operation.type}`);
    let query = client.from(p.table);
    query = operation.type === 'owner.expiry_insert' ? query.insert(p.values) : query.update(p.values);
    for (const [method, key, value] of p.filters || []) query = query[method](key, value);
    return query;
  } };
}

/**
 * The caller owns an exclusive lease. A cursor only passes fully handled rows;
 * an interrupted effect is repaired from the immutable, pre-mutation journal.
 * The budget is cooperative: no Promise.race leaves writes running in background.
 */
export async function processTenantAnnualExpirySweep(client, tenantId, results = null, now = new Date(), options = {}) {
  const effects = options.effects || annualExpiryEffects(client, options.invalidateSessions);
  const trace = options.trace || (() => {});
  const skip = reason => trace({ stage: 'annual-expiry', status: 'skipped', reason });
  async function mutate(type, description, payload) {
    const result = await effects.perform({ type, stage: 'annual-expiry', description, payload,
      conditional: 'Later expiry/access work depends on the durable journal and compare-and-set results; no result is assumed.' });
    if (result?.error) throw new Error(`Could not ${description.charAt(0).toLowerCase() + description.slice(1)}: ${result.error.message}`);
    return result;
  }
  let cursor = { historyType: 'member', afterId: null, ...options.cursor };
  let enforced = 0;
  let examined = 0;
  const configs = new Map();
  const assignedPolicies = new Map();
  const today = now.toISOString().slice(0, 10);
  const deferred = new Error('Annual expiry budget deferred');
  function guard() {
    if (options.shouldContinue && !options.shouldContinue()) throw deferred;
  }
  async function read(makeQuery, message) {
    guard();
    const { data, error } = await makeQuery();
    if (error) throw new Error(`${message}: ${error.message}`);
    return data;
  }
  async function checkpoint(next) {
    // Saving progress is always allowed, even when the processing budget elapsed.
    await options.checkpoint?.(next);
    cursor = next;
    await options.onProgress?.({ tenantId, enforced, examined, cursor });
  }
  async function anyPage(makeQuery, predicate, message) {
    let after = null;
    while (true) {
      const rows = await read(() => {
        let query = makeQuery().order('id', { ascending: true }).limit(PAGE_SIZE);
        if (after) query = query.gt('id', after);
        return query;
      }, message);
      if (!rows?.length) return false;
      for (const row of rows) if (await predicate(row)) return true;
      after = rows.at(-1).id;
      // Always fetch to an empty page: even a server-side cap below our limit
      // must not silently truncate protections or the sweep.
    }
  }
  function candidate(history) {
    return !['cancelled', 'void', 'scheduled'].includes(history.status)
      && isAnnualNonRecurring(history)
      && !(history.term_end_date && history.term_end_date >= today);
  }
  async function prepareConfigs(rows) {
    const ids = [...new Set(rows.filter(candidate)
      .filter(row => !row.commitment_snapshot?.config)
      .map(row => row.config_id).filter(id => id && !configs.has(id)))];
    for (let start = 0; start < ids.length; start += PAGE_SIZE) {
      const batch = ids.slice(start, start + PAGE_SIZE);
      const found = new Map();
      await anyPage(() => client.from('membership_tier_config').select('*')
        .eq('tenant_id', tenantId).in('id', batch), row => {
        found.set(row.id, row);
        return false;
      }, 'Could not load expiry policies');
      for (const id of batch) configs.set(id, found.get(id) || null);
    }
  }
  async function markHistory(history, state) {
    guard();
    await mutate('owner.expiry_update', 'Complete expiry history', {
      table: TABLES[cursor.historyType], values: {
      expiry_enforced_at: now.toISOString(), annual_renewal_state: state,
      expiry_enforcement_key: `annual-expiry:${history.id}:${history.term_end_date}`,
      }, filters: [['eq', 'tenant_id', tenantId], ['eq', 'id', history.id], ['is', 'expiry_enforced_at', null]],
    });
  }
  async function renewed(history, term) {
    const column = cursor.historyType === 'member' ? 'member_id' : 'organization_id';
    return anyPage(() => {
      let query = client.from(TABLES[cursor.historyType]).select('*').eq('tenant_id', tenantId)
        .eq(column, history[column]).neq('id', history.id).in('status', ['active', 'scheduled']);
      const next = term.nextStart.toISOString().slice(0, 10);
      return history.term_key
        ? query.eq('term_start_date', next).eq('previous_term_id', history.id)
        : query.gte('term_start_date', next);
    }, async row => isAnnualPaid(row) || (assignedPolicies.get(history.id)
      && await isElectedExpiryOnlyRecurringSuccessor(client, tenantId, history, row, now, read)),
    'Could not check renewed membership');
  }
  async function protectedMember(member, history) {
    if (member.membership_paused === true) return true;
    guard();
    if (await isTenantAdmin(client, tenantId, member)) return true;
    if (cursor.historyType === 'member') {
      if (!member.organization_id) return false;
      return anyPage(() => client.from(TABLES.organisation).select('*').eq('tenant_id', tenantId)
        .eq('organization_id', member.organization_id).eq('status', 'active')
        .lte('term_start_date', today).gte('term_end_date', today),
      row => isCurrentMembershipProtection(row, now), 'Could not check inherited protection');
    }
    // Membership association is rechecked from the freshly read member.
    if (member.organization_id !== history.organization_id) return true;
    return anyPage(() => client.from(TABLES.member).select('*').eq('tenant_id', tenantId)
      .eq('member_id', member.id).in('status', ['active', 'scheduled']).gte('term_end_date', today),
    row => isCurrentMembershipProtection(row, now), 'Could not check personal protection');
  }
  async function enforce(member, history, config, protectionChecked = false) {
    if (!protectionChecked && await protectedMember(member, history)) return false;
    const identity = () => client.from('membership_expiry_action').select('*')
      .eq('tenant_id', tenantId).eq('history_type', cursor.historyType)
      .eq('history_id', history.id).eq('member_id', member.id).maybeSingle();
    let action = await read(identity, 'Could not read expiry journal');
    if (action?.action_state === 'completed') return false;
    if (!action) {
      const policy = normalizeAnnualRenewalConfig(config);
      // Insert, never upsert: retries must never replace the original values.
      guard();
      await mutate('owner.expiry_insert', 'Prepare expiry journal', { table: 'membership_expiry_action', values: {
        tenant_id: tenantId, history_type: cursor.historyType, history_id: history.id,
        member_id: member.id, config_id: history.config_id,
        previous_login_enabled: member.login_enabled, previous_role_id: member.role_id,
        login_disabled: policy.disableLogin && member.login_enabled !== false,
        assigned_role_id: policy.changeRole ? policy.fallbackRoleId : null,
        applied_at: now.toISOString(), action_state: 'pending',
        details: { source: 'annual_membership_expiry_sweep',
          ...(assignedPolicies.get(history.id) ? {
            expiry_policy_assignment_id: assignedPolicies.get(history.id).assignmentId,
            renewal_policy_config_id: assignedPolicies.get(history.id).configId,
          } : {}) },
      } });
      action = await read(identity, 'Could not reload expiry journal');
      if (!action) throw new Error('Prepared expiry journal was not found');
    }
    if (action.action_state !== 'pending') throw new Error('Unknown expiry journal state');
    // Field-level compare-and-set avoids overwriting unrelated manual changes
    // made after preparation, including when repairing a killed invocation.
    const changes = [];
    if (action.login_disabled) changes.push(['login_enabled', action.previous_login_enabled, false]);
    if (action.assigned_role_id) changes.push(['role_id', action.previous_role_id, action.assigned_role_id]);
    for (const [field, previous, target] of changes) {
      if (member[field] === target) continue;
      guard();
      await mutate('owner.expiry_update', 'Enforce member expiry', {
        table: 'member', values: { [field]: target },
        filters: [['eq', 'tenant_id', tenantId], ['eq', 'id', member.id], [previous == null ? 'is' : 'eq', field, previous ?? null]],
      });
    }
    if (action.login_disabled) {
      guard();
      const outcome = await effects.perform({ type: 'owner.expiry_sessions', stage: 'annual-expiry',
        description: 'Invalidate sessions for the expired member.', payload: { memberId: member.id } });
      if (!outcome?.success) throw new Error(`Could not invalidate sessions for expired member ${member.id}`);
    }
    guard();
    await mutate('owner.expiry_update', 'Complete expiry journal', {
      table: 'membership_expiry_action', values: { action_state: 'completed', completed_at: now.toISOString() },
      filters: [['eq', 'tenant_id', tenantId], ['eq', 'id', action.id], ['eq', 'action_state', 'pending']],
    });
    enforced++;
    if (results) results.processed = (results.processed || 0) + 1;
    return true;
  }
  async function processHistory(history) {
    if (!candidate(history)) { skip(`History ${history.id} is not an expired annual non-recurring candidate.`); return; }
    if (cursor.historyType === 'member' && isAttestedExpiryOnlyHistory(history, tenantId)
        && !assignedPolicies.has(history.id)) {
      guard();
      assignedPolicies.set(history.id, await loadExpiryOnlyRenewalPolicy(client, { tenantId, history }));
    }
    const assignedPolicy = assignedPolicies.get(history.id);
    const config = assignedPolicy ? expiryOnlyPolicyConfig(assignedPolicy)
      : history.commitment_snapshot?.config || configs.get(history.config_id);
    if (!config && cursor.historyType === 'member' && isAttestedExpiryOnlyHistory(history, tenantId)) {
      const detail = { tenantId, historyId: history.id, memberId: history.member_id,
        stage: 'annual-expiry', status: 'review_required', code: 'legacy_expiry_policy_unassigned',
        reason: 'Attested legacy expiry-only membership has no assigned historical expiry policy. Administrator review must establish access policy authority; no commencement, policy or access change was inferred.' };
      // The existing task log is the durable review channel. Persist BEFORE
      // allowing the cursor past this row, even if final runner logging fails.
      guard();
      await mutate('owner.expiry_insert', 'Record legacy expiry policy review', {
        table: 'scheduled_task_log', values: {
          tenant_id: tenantId, task_name: 'membership_renewals', task_display_name: 'Membership Renewals',
          status: 'error', executed_at: now.toISOString(),
          details: JSON.stringify({ outcome: 'review_required', details: [detail] }),
        },
      });
      // The runner retains the identity across invocations before this row can
      // leave the cursor. The log is human-readable evidence, not resolution.
      await options.reviewRequired?.(history.id);
      if (results) {
        results.errors = (results.errors || 0) + 1;
        if (options.reviewRequired) {
          // Only a durably retained review can be separated from availability.
          results.isolatedErrors = (results.isolatedErrors || 0) + 1;
          detail.isolated = true;
        }
        results.details?.push(detail);
      }
      trace({ stage: 'annual-expiry', status: 'blocked', reason: detail.reason });
      return;
    }
    if (!config) throw new Error(`Expiry policy missing for history ${history.id}`);
    if (config.start_mode === 'immediate' && !history.commitment_snapshot) {
      trace({ stage: 'annual-expiry', status: 'blocked', reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      results?.details?.push({ tenantId, historyId: history.id, status: 'review_required',
        reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      return;
    }
    const policy = normalizeAnnualRenewalConfig(config);
    if (!policy.disableLogin && !policy.changeRole) { skip('Expiry policy does not disable login or change roles.'); return; }
    const lifecycle = assignedPolicy ? expiryOnlyLifecycle(assignedPolicy, now)
      : await resolveAnnualRenewal(client, { tenantId, history, config, now });
    if (!lifecycle.applicable || lifecycle.state !== 'expired') { skip(`Annual lifecycle is ${lifecycle.state || 'not applicable'}.`); return; }
    if (await renewed(history, lifecycle.term)) {
      await markHistory(history, 'renewed');
      return;
    }
    if (cursor.historyType === 'member') {
      const member = await read(() => client.from('member').select(MEMBER_FIELDS)
        .eq('tenant_id', tenantId).eq('id', history.member_id).maybeSingle(), 'Could not load member');
      if (!member || await protectedMember(member, history)) { skip('Member missing or protected by pause, administrator role or current inherited membership.'); return; }
      await enforce(member, history, config, true);
      await markHistory(history, 'expired');
      return;
    }
    if (cursor.historyId !== history.id) {
      await checkpoint({ ...cursor, historyId: history.id, memberAfterId: null });
    }
    while (true) {
      const members = await read(() => {
        let query = client.from('member').select(MEMBER_FIELDS).eq('tenant_id', tenantId)
          .eq('organization_id', history.organization_id).order('id', { ascending: true }).limit(PAGE_SIZE);
        if (cursor.memberAfterId) query = query.gt('id', cursor.memberAfterId);
        return query;
      }, 'Could not load organisation members');
      if (!members?.length) break;
      for (const member of members) {
        guard();
        await enforce(member, history, config);
        await checkpoint({ ...cursor, memberAfterId: member.id });
      }
    }
    await markHistory(history, 'expired');
  }
  try {
    // Revisit durable review identities independently of the traversal cursor.
    // Missing/deleted evidence never clears a review; a repaired, explicitly
    // assigned policy must successfully pass normal expiry processing first.
    const reviewIds = options.reviewHistoryIds || [];
    const reviewRows = new Map();
    let reviewPolicyReaders = new Map();
    if (reviewIds.length) {
      await anyPage(() => client.from(TABLES.member).select('*')
        .eq('tenant_id', tenantId).in('id', reviewIds), history => {
        reviewRows.set(history.id, history);
        return false;
      }, 'Could not reload expiry policy reviews');
      await prepareConfigs([...reviewRows.values()]);
      guard();
      reviewPolicyReaders = await prepareExpiryOnlyRenewalPolicies(client, {
        tenantId, histories: [...reviewRows.values()], guard,
      });
    }
    for (const historyId of reviewIds) {
      const history = reviewRows.get(historyId);
      if (!history) throw new Error(`Expiry policy review history missing: ${historyId}`);
      if (reviewPolicyReaders.has(historyId)) {
        guard();
        const load = reviewPolicyReaders.get(historyId);
        assignedPolicies.set(historyId, load ? await load() : null);
      }
      const assignedPolicy = assignedPolicies.get(history.id);
      const config = history.commitment_snapshot?.config || configs.get(history.config_id);
      const explicitPolicy = assignedPolicy || (config && config.tenant_id === tenantId
        && typeof config.renewal_disable_login === 'boolean'
        && typeof config.renewal_change_role === 'boolean'
        && Number.isInteger(config.renewal_grace_days) && config.renewal_grace_days >= 0
        && config.renewal_grace_days <= 366
        && (!config.renewal_change_role || !!config.renewal_fallback_role_id)
        && !(config.start_mode === 'immediate' && !history.commitment_snapshot));
      if (!explicitPolicy) continue;
      const traversalCursor = cursor;
      try {
        cursor = { historyType: 'member', afterId: null };
        await processHistory(history);
        await options.reviewResolved?.(historyId);
      } finally {
        cursor = traversalCursor;
      }
    }
    while (true) {
      const rows = await read(() => {
        let query = client.from(TABLES[cursor.historyType]).select('*').eq('tenant_id', tenantId)
          .is('expiry_enforced_at', null).order('id', { ascending: true }).limit(PAGE_SIZE);
        if (options.owner) {
          const column = cursor.historyType === 'member' ? 'member_id' : 'organization_id';
          if (!options.owner[column]) return Promise.resolve({ data: [] });
          query = query.eq(column, options.owner[column]);
        }
        if (cursor.afterId) query = query.gt('id', cursor.afterId);
        return query;
      }, 'Could not load expiry candidates');
      if (!rows?.length) {
        if (cursor.historyType === 'organisation') return { enforced, examined, complete: true, cursor: null };
        await checkpoint({ historyType: 'organisation', afterId: null });
        continue;
      }
      await prepareConfigs(rows);
      for (const history of rows) {
        guard();
        await processHistory(history);
        examined++;
        cursor = { historyType: cursor.historyType, afterId: history.id };
      }
      // Read-only skips need no per-row database writes. Replaying a page after
      // an abrupt kill is safe: completed effects have durable action journals.
      await checkpoint(cursor);
    }
  } catch (error) {
    if (error !== deferred && error.code !== 'RENEWAL_BUDGET_EXHAUSTED') throw error;
    await checkpoint(cursor);
    return { enforced, examined, complete: false, cursor };
  }
}