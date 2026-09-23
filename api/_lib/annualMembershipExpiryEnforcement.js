import { normalizeAnnualRenewalConfig, resolveAnnualRenewal, isAnnualNonRecurring } from './annualRenewalPolicy.js';
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
      if (rows.some(predicate)) return true;
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
    }, isAnnualPaid, 'Could not check renewed membership');
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
        details: { source: 'annual_membership_expiry_sweep' },
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
    const config = history.commitment_snapshot?.config || configs.get(history.config_id);
    if (!config) throw new Error(`Expiry policy missing for history ${history.id}`);
    if (config.start_mode === 'immediate' && !history.commitment_snapshot) {
      trace({ stage: 'annual-expiry', status: 'blocked', reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      results?.details?.push({ tenantId, historyId: history.id, status: 'review_required',
        reason: 'Legacy rolling term has no trusted commitment; expiry was not guessed.' });
      return;
    }
    const policy = normalizeAnnualRenewalConfig(config);
    if (!policy.disableLogin && !policy.changeRole) { skip('Expiry policy does not disable login or change roles.'); return; }
    const lifecycle = await resolveAnnualRenewal(client, { tenantId, history, config, now });
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
    if (error !== deferred) throw error;
    await checkpoint(cursor);
    return { enforced, examined, complete: false, cursor };
  }
}