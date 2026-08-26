/**
 * Cron: process automatic membership groups.
 *
 * Runs every minute (see vercel.json). Processes enabled groups fairly within
 * a 50-second wall-clock budget:
 *
 * - queued / running groups: continue via cursor (active reconciliation in flight).
 * - error groups: atomically requeue so transient failures are retried.
 * - idle groups: re-evaluate periodically so live CRM data changes are picked up.
 *   Ordered by automatic_membership_last_synced_at ASC NULLS FIRST so the
 *   least-recently synced group is processed next.
 *
 * Stale-worker fencing:
 * - Each group carries an automatic_membership_generation counter that the DB
 *   trigger increments whenever enabled/role/filter_groups changes.
 * - Workers pass p_expected_generation and p_expected_cursor to the RPC; the
 *   RPC rejects with STALE_GENERATION or CURSOR_MISMATCH if another worker or
 *   a config change has raced ahead.
 * - Error/status updates after query failures use .eq(generation) so stale
 *   workers cannot overwrite newer state.
 *
 * Idle claim:
 * - Uses UPDATE...RETURNING to atomically claim idle rows; processes only rows
 *   returned by the claim (concurrent invocations skip already-claimed rows).
 *
 * Auth: requires CRON_SECRET bearer token only.
 */

import { createClient } from '@supabase/supabase-js';
import {
  validateAutomaticMembershipSettings,
  fetchAllowedCustomFieldIdsByScope,
  buildFieldMeta,
  roleExistsInGroup,
} from '../_lib/automaticMembership.js';
import { runFilterQuery } from '../_lib/automaticMembershipQuery.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

const supabaseUrl        = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const WALL_CLOCK_BUDGET_MS    = 50_000;
const BATCH_SIZE              = 500;
const MAX_GROUPS_PER_RUN      = 20;
const MAX_ERROR_RETRIES_PER_RUN = 5;
const IDLE_RESYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const GROUP_COLS = [
  'id', 'name', 'tenant_id', 'roles',
  'automatic_membership_enabled',
  'automatic_membership_role',
  'automatic_membership_filter_groups',
  'automatic_membership_sync_status',
  'automatic_membership_last_synced_at',
  'automatic_membership_cursor',
  'automatic_membership_generation',
].join(', ');

export function isAutomaticMembershipHeartbeatHealthy(results, setupErrors = 0) {
  return setupErrors === 0 && (results || []).every((result) => result?.status !== 'error');
}

async function awaitCronQuery(query, reportHeartbeat) {
  try {
    return await query;
  } catch (error) {
    await reportHeartbeat(false);
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers?.authorization || '').trim();
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.automaticMembershipProcessing,
  });

  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startMs = Date.now();
  const results = [];
  let setupErrors = 0;

  // ── 1. Queued / running groups ──────────────────────────────────────────
  let activeGroups;
  let activeErr;
  try {
    ({ data: activeGroups, error: activeErr } = await supabase
      .from('member_group')
      .select(GROUP_COLS)
      .eq('automatic_membership_enabled', true)
      .in('automatic_membership_sync_status', ['queued', 'running'])
      .order('id')
      .limit(MAX_GROUPS_PER_RUN));
  } catch (error) {
    console.error('[AutoMembershipCron] fetch active groups threw:', error.message || error);
    await reportHeartbeat(false);
    return res.status(500).json({ error: error.message || String(error) });
  }

  if (activeErr) {
    console.error('[AutoMembershipCron] fetch active groups error:', activeErr.message);
    await reportHeartbeat(false);
    return res.status(500).json({ error: activeErr.message });
  }

  // ── 2. Error groups eligible for retry ───────────────────────────────────
  // Queued/running work stays ahead of retries so persistent errors cannot
  // starve active reconciliations.
  let remainingSlots = MAX_GROUPS_PER_RUN - (activeGroups?.length || 0);
  let claimedErrorGroups = [];
  if (remainingSlots > 0) {
    const { data: errorCandidates, error: errorFindErr } = await awaitCronQuery(supabase
      .from('member_group')
      .select('id')
      .eq('automatic_membership_enabled', true)
      .eq('automatic_membership_sync_status', 'error')
      .order('id')
      .limit(Math.min(MAX_ERROR_RETRIES_PER_RUN, remainingSlots)), reportHeartbeat);

    if (errorFindErr) {
      console.error('[AutoMembershipCron] find error groups error:', errorFindErr.message);
      setupErrors++;
    } else if (errorCandidates && errorCandidates.length > 0) {
      const { data: claimed, error: claimErr } = await awaitCronQuery(supabase
        .from('member_group')
        .update({ automatic_membership_sync_status: 'queued' })
        .in('id', errorCandidates.map(group => group.id))
        .eq('automatic_membership_sync_status', 'error')
        .select(GROUP_COLS), reportHeartbeat);
      if (claimErr) {
        console.error('[AutoMembershipCron] claim error groups error:', claimErr.message);
        setupErrors++;
      } else {
        claimedErrorGroups = claimed || [];
        remainingSlots -= claimedErrorGroups.length;
      }
    }
  }

  // ── 3. Idle groups eligible for re-sync ─────────────────────────────────
  // Use UPDATE...RETURNING to atomically claim idle rows.
  // Only rows still in 'idle' status and eligible by timestamp are claimed.
  const idleEligibleBefore = new Date(Date.now() - IDLE_RESYNC_INTERVAL_MS).toISOString();
  let claimedIdleGroups = [];

  if (remainingSlots > 0) {
    // First: find candidate IDs (SELECT is cheaper than UPDATE for finding rows)
    const { data: idleCandidates, error: idleFindErr } = await awaitCronQuery(supabase
      .from('member_group')
      .select('id')
      .eq('automatic_membership_enabled', true)
      .eq('automatic_membership_sync_status', 'idle')
      .or(`automatic_membership_last_synced_at.is.null,automatic_membership_last_synced_at.lt.${idleEligibleBefore}`)
      .order('automatic_membership_last_synced_at', { ascending: true, nullsFirst: true })
      .order('id')
      .limit(remainingSlots), reportHeartbeat);

    if (idleFindErr) {
      console.error('[AutoMembershipCron] find idle groups error:', idleFindErr.message);
      setupErrors++;
      // Non-fatal: continue with active groups only
    } else if (idleCandidates && idleCandidates.length > 0) {
      const candidateIds = idleCandidates.map(g => g.id);

      // Atomically flip to queued (conditional on still being idle)
      const { data: claimed, error: claimErr } = await awaitCronQuery(supabase
        .from('member_group')
        .update({ automatic_membership_sync_status: 'queued', automatic_membership_cursor: null })
        .in('id', candidateIds)
        .eq('automatic_membership_sync_status', 'idle')
        .select(GROUP_COLS), reportHeartbeat);

      if (claimErr) {
        console.error('[AutoMembershipCron] claim idle groups error:', claimErr.message);
        setupErrors++;
        // Non-fatal: continue with active groups only
      } else {
        claimedIdleGroups = claimed || [];
      }
    }
  }

  const allGroups = [...(activeGroups || []), ...claimedErrorGroups, ...claimedIdleGroups];

  for (const group of allGroups) {
    if (Date.now() - startMs > WALL_CLOCK_BUDGET_MS) {
      console.log('[AutoMembershipCron] wall-clock budget exhausted, stopping');
      break;
    }
    const result = await processGroup(group);
    results.push(result);
  }

  await reportHeartbeat(isAutomaticMembershipHeartbeatHealthy(results, setupErrors));
  return res.json({
    processed: results.length,
    results,
    elapsedMs: Date.now() - startMs,
  });
}

async function processGroup(group) {
  const groupId  = group.id;
  const tenantId = group.tenant_id;
  // Capture generation and cursor at the time we read the row
  const expectedGeneration = group.automatic_membership_generation ?? 0;
  const expectedCursor     = group.automatic_membership_cursor ?? null;

  try {
    const scopeResult = await fetchAllowedCustomFieldIdsByScope(supabase, tenantId);
    const allowedCustomFieldIdsByScope = scopeResult;
    const fieldMeta = buildFieldMeta(scopeResult);

    const roleCheck = (role) => roleExistsInGroup(role, group.roles || []);
    const validation = await validateAutomaticMembershipSettings(group, {
      allowedCustomFieldIdsByScope,
      fieldMeta,
      roleExists: roleCheck,
    });

    if (!validation.ok) {
      const { error: updErr } = await supabase
        .from('member_group')
        .update({
          automatic_membership_sync_status: 'error',
          automatic_membership_sync_error: validation.error,
          automatic_membership_cursor: null,
        })
        .eq('id', groupId)
        .eq('automatic_membership_generation', expectedGeneration);
      if (updErr) console.error(`[AutoMembershipCron] failed to write error status for group ${groupId}:`, updErr.message);
      return { groupId, status: 'error', error: validation.error };
    }

    // Mark running (from queued) — generation-fenced
    await supabase
      .from('member_group')
      .update({ automatic_membership_sync_status: 'running' })
      .eq('id', groupId)
      .eq('automatic_membership_sync_status', 'queued')
      .eq('automatic_membership_generation', expectedGeneration);

    const filterGroups = group.automatic_membership_filter_groups || [];
    let fullTargetIds;
    try {
      fullTargetIds = await runFilterQuery({
        supabase,
        tenantId,
        filterGroups,
        allowedCustomFieldIdsByScope,
      });
    } catch (filterErr) {
      const { error: updErr } = await supabase
        .from('member_group')
        .update({
          automatic_membership_sync_status: 'error',
          automatic_membership_sync_error: filterErr.message,
        })
        .eq('id', groupId)
        .eq('automatic_membership_generation', expectedGeneration);
      if (updErr) console.error(`[AutoMembershipCron] failed to write filter error for group ${groupId}:`, updErr.message);
      return { groupId, status: 'error', error: filterErr.message };
    }

    const cursorIndex  = parseCursor(expectedCursor);
    const batchSlice   = fullTargetIds.slice(cursorIndex, cursorIndex + BATCH_SIZE);
    const nextIndex    = cursorIndex + batchSlice.length;
    const isFinalBatch = nextIndex >= fullTargetIds.length;
    const nextCursor   = isFinalBatch ? null : String(nextIndex);

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'reconcile_automatic_membership',
      {
        p_group_id:            groupId,
        p_tenant_id:           tenantId,
        p_role:                group.automatic_membership_role,
        p_batch_member_ids:    batchSlice,
        p_full_target_ids:     fullTargetIds,
        p_is_final_batch:      isFinalBatch,
        p_next_cursor:         nextCursor,
        p_full_match_count:    fullTargetIds.length,
        p_expected_generation: expectedGeneration,
        p_expected_cursor:     expectedCursor,
      }
    );

    if (rpcError) {
      console.error(`[AutoMembershipCron] RPC error for group ${groupId}:`, rpcError.message);
      await supabase
        .from('member_group')
        .update({
          automatic_membership_sync_status: 'error',
          automatic_membership_sync_error: rpcError.message,
        })
        .eq('id', groupId)
        .eq('automatic_membership_generation', expectedGeneration);
      return { groupId, status: 'error', error: rpcError.message };
    }

    if (!rpcResult?.ok) {
      const code   = rpcResult?.code;
      const detail = rpcResult?.detail || 'RPC returned not ok';
      // STALE_GENERATION / CURSOR_MISMATCH: do NOT write error; the newer worker owns state
      if (code === 'STALE_GENERATION' || code === 'CURSOR_MISMATCH') {
        return { groupId, status: 'stale', code, error: detail };
      }
      await supabase
        .from('member_group')
        .update({
          automatic_membership_sync_status: 'error',
          automatic_membership_sync_error: detail,
        })
        .eq('id', groupId)
        .eq('automatic_membership_generation', expectedGeneration);
      return { groupId, status: 'error', code, error: detail };
    }

    return {
      groupId,
      status: isFinalBatch ? 'idle' : 'running',
      inserted: rpcResult.inserted || 0,
      deleted: rpcResult.deleted || 0,
      matchCount: fullTargetIds.length,
      hasMore: !isFinalBatch,
    };
  } catch (err) {
    console.error(`[AutoMembershipCron] unexpected error for group ${groupId}:`, err.message || err);
    try {
      await supabase
        .from('member_group')
        .update({
          automatic_membership_sync_status: 'error',
          automatic_membership_sync_error: err.message || String(err),
        })
        .eq('id', groupId)
        .eq('automatic_membership_generation', expectedGeneration);
    } catch (_) { /* best-effort */ }
    return { groupId, status: 'error', error: err.message || String(err) };
  }
}

function parseCursor(cursor) {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return isNaN(n) ? 0 : n;
}
