// Member membership pause (Task #3586).
//
// A pause suspends BOTH system access and recurring membership payments for
// one member (e.g. maternity leave), distinct from the manual login-enabled
// toggle which is left untouched:
//   - access is blocked at session resolution + every login path via the
//     membership_paused flag (login_enabled is never rewritten, so a member
//     disabled for other reasons stays disabled after resume);
//   - any active GoCardless membership subscription is paused/resumed, and
//     the subscription ids we paused are recorded so resume only resumes
//     what pause stopped (idempotent);
//   - the hourly renewal cron excludes paused members from member renewal
//     invoicing, DD renewals and payment reminders, and auto-resumes pauses
//     whose restart date has arrived.
//
// Pause state lives in columns on `member` (see MEMBER_PAUSE_FIELDS). They
// exist on the production (DEST) database only; every read helper here is
// 42703-tolerant so environments without the columns behave as "nobody is
// paused". The generic entity API strips these fields from member writes —
// state changes only via pauseMember/resumeMember.

import { supabase as defaultSupabase } from './database.js';
import { invalidateMemberSessions } from './session.js';
import { gocardlessForTenant } from './gocardless.js';
import { STATUS } from './gocardlessState.js';

export const MEMBER_PAUSE_FIELDS = Object.freeze([
  'membership_paused',
  'membership_paused_at',
  'membership_pause_restart_date',
  'membership_paused_by',
  'membership_pause_reason',
  'membership_pause_gc_subscriptions',
]);

/** Strip pause fields from a mutable request body (entity API guard). */
export function stripMemberPauseFields(body) {
  const stripped = [];
  if (!body || typeof body !== 'object') return stripped;
  for (const f of MEMBER_PAUSE_FIELDS) {
    if (f in body) {
      delete body[f];
      stripped.push(f);
    }
  }
  return stripped;
}

/** True when a member row is currently paused. Missing column => false. */
export function isMemberPaused(member) {
  return member?.membership_paused === true;
}

/**
 * Decide whether a paused member's scheduled restart has arrived.
 * Restart date is a plain date (tenant-day granularity); compare on UTC date.
 */
export function isRestartDue(member, now = new Date()) {
  if (!isMemberPaused(member)) return false;
  const restart = member.membership_pause_restart_date;
  if (!restart) return false;
  const d = new Date(`${String(restart).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() >= d.getTime();
}

function isMissingColumnError(error) {
  return error && (error.code === '42703' || error.code === '42P01');
}

/**
 * Ids of paused members for one tenant, as a Set. Used by the renewal cron
 * to exclude paused members. Returns an empty set when the pause columns do
 * not exist (pre-migration environments).
 */
export async function getPausedMemberIdSet(tenantId, db = defaultSupabase) {
  if (!db || !tenantId) return new Set();
  const { data, error } = await db
    .from('member')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('membership_paused', true);
  if (error) {
    if (!isMissingColumnError(error)) {
      console.error('[MemberPause] paused-set query failed:', error.message);
    }
    return new Set();
  }
  return new Set((data || []).map((r) => r.id));
}

async function fetchMemberForPause(tenantId, memberId, db) {
  const { data, error } = await db
    .from('member')
    .select('*')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load member: ${error.message}`);
  return data || null;
}

async function insertPauseNote({ memberId, authorMemberId, content, db }) {
  const { error } = await db.from('member_note').insert({
    target_member_id: memberId,
    author_member_id: authorMemberId || null,
    content,
    attachments: [],
  });
  if (error) console.error('[MemberPause] Failed to insert member note:', error.message);
  return !error;
}

// Plan statuses where a GC subscription is (or may be) actively collecting.
const PAUSABLE_PLAN_STATUSES = [
  STATUS.ACTIVE,
  STATUS.FIRST_PAYMENT_PENDING,
  STATUS.PAYMENT_GRACE_PERIOD,
  STATUS.PAYMENT_OVERDUE,
];

async function pauseMemberGcSubscriptions({ tenantId, memberId, db, gcFactory }) {
  const pausedIds = [];
  const warnings = [];
  const { data: plans, error } = await db
    .from('membership_payment_plans')
    .select('id, status, gocardless_subscription_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .not('gocardless_subscription_id', 'is', null)
    .in('status', PAUSABLE_PLAN_STATUSES);
  if (error) {
    if (!isMissingColumnError(error)) warnings.push(`GC plan lookup failed: ${error.message}`);
    return { pausedIds, warnings };
  }
  if (!plans?.length) return { pausedIds, warnings };

  let gc;
  try {
    gc = await gcFactory(tenantId);
  } catch (err) {
    warnings.push(`GoCardless not available for tenant: ${err.message}`);
    return { pausedIds, warnings };
  }

  for (const plan of plans) {
    try {
      await gc.pauseSubscription(plan.gocardless_subscription_id, { pauseCycles: null });
      pausedIds.push(plan.gocardless_subscription_id);
    } catch (err) {
      // Already-paused subscriptions still count as "paused by us" so resume
      // will restart them; other failures are surfaced as warnings.
      const msg = String(err?.message || err);
      if (/paused/i.test(msg)) {
        pausedIds.push(plan.gocardless_subscription_id);
      } else {
        warnings.push(`Failed to pause GoCardless subscription ${plan.gocardless_subscription_id}: ${msg}`);
      }
    }
  }
  return { pausedIds, warnings };
}

async function resumeMemberGcSubscriptions({ tenantId, subscriptionIds, gcFactory }) {
  const warnings = [];
  if (!subscriptionIds?.length) return { warnings };
  let gc;
  try {
    gc = await gcFactory(tenantId);
  } catch (err) {
    warnings.push(`GoCardless not available for tenant: ${err.message}`);
    return { warnings };
  }
  for (const subId of subscriptionIds) {
    try {
      await gc.resumeSubscription(subId);
    } catch (err) {
      const msg = String(err?.message || err);
      // Not paused / already finished => resume is a no-op (idempotent).
      if (!/not_paused|not paused|finished|cancelled/i.test(msg)) {
        warnings.push(`Failed to resume GoCardless subscription ${subId}: ${msg}`);
      }
    }
  }
  return { warnings };
}

function formatDate(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}

/**
 * Pause a member. Idempotent: pausing an already-paused member updates the
 * restart date/reason but does not duplicate GC pauses or notes' side effects.
 *
 * Returns { ok, alreadyPaused?, warnings: [] } or { ok:false, error }.
 */
export async function pauseMember({
  tenantId,
  memberId,
  reason,
  restartDate = null,
  actorName = null,
  actorMemberId = null,
  db = defaultSupabase,
  gcFactory = gocardlessForTenant,
  invalidateSessions = invalidateMemberSessions,
}) {
  if (!reason || !String(reason).trim()) {
    return { ok: false, error: 'A reason is required to pause a member' };
  }
  const member = await fetchMemberForPause(tenantId, memberId, db);
  if (!member) return { ok: false, error: 'Member not found' };

  const alreadyPaused = isMemberPaused(member);
  const warnings = [];

  // 1) Persist pause state FIRST (login_enabled untouched by design). If
  //    this fails we stop before touching GoCardless, so remote and local
  //    state can never diverge with the pause unrecorded.
  const { error: updateError } = await db
    .from('member')
    .update({
      membership_paused: true,
      membership_paused_at: alreadyPaused && member.membership_paused_at
        ? member.membership_paused_at
        : new Date().toISOString(),
      membership_pause_restart_date: restartDate || null,
      membership_paused_by: actorName || null,
      membership_pause_reason: String(reason).trim(),
    })
    .eq('id', memberId)
    .eq('tenant_id', tenantId);
  if (updateError) {
    return { ok: false, error: `Failed to record pause: ${updateError.message}` };
  }

  // 2) Kill existing sessions so access stops immediately.
  try {
    await invalidateSessions(memberId);
  } catch (err) {
    warnings.push(`Failed to invalidate sessions: ${err.message}`);
  }

  // 3) Pause GC subscriptions (skip when already paused by us), then record
  //    which ones we paused. If recording fails, resume falls back to the
  //    member's active plans (resuming a not-paused subscription is a
  //    tolerated no-op), so the ids are a fast path, not the only path.
  let gcSubscriptionIds = Array.isArray(member.membership_pause_gc_subscriptions)
    ? member.membership_pause_gc_subscriptions
    : [];
  if (!alreadyPaused) {
    const gcResult = await pauseMemberGcSubscriptions({ tenantId, memberId, db, gcFactory });
    gcSubscriptionIds = gcResult.pausedIds;
    warnings.push(...gcResult.warnings);
    const { error: gcRecordError } = await db
      .from('member')
      .update({ membership_pause_gc_subscriptions: gcSubscriptionIds })
      .eq('id', memberId)
      .eq('tenant_id', tenantId);
    if (gcRecordError) {
      warnings.push(`Paused GoCardless subscription(s) but failed to record ids (resume will use plan fallback): ${gcRecordError.message}`);
    }
  }

  // 4) Record the reason as a member note (visible in the notes UI).
  if (!alreadyPaused) {
    const parts = [
      `[Membership Paused] ${String(reason).trim()}`,
      actorName ? `Paused by: ${actorName}` : null,
      restartDate ? `Scheduled restart: ${formatDate(restartDate)}` : null,
      gcSubscriptionIds.length ? `Paused GoCardless subscription(s): ${gcSubscriptionIds.join(', ')}` : null,
      warnings.length ? `Warnings: ${warnings.join('; ')}` : null,
    ].filter(Boolean);
    await insertPauseNote({ memberId, authorMemberId: actorMemberId, content: parts.join('\n'), db });
  }

  return { ok: true, alreadyPaused, warnings };
}

/**
 * Resume a paused member. Idempotent: resuming a non-paused member is a
 * successful no-op. Only re-enables access that the pause itself blocked
 * (login_enabled is never touched), and only resumes the GC subscriptions
 * the pause recorded.
 *
 * Set `auto: true` for the cron's scheduled restart (note wording differs).
 */
export async function resumeMember({
  tenantId,
  memberId,
  actorName = null,
  actorMemberId = null,
  auto = false,
  db = defaultSupabase,
  gcFactory = gocardlessForTenant,
}) {
  const member = await fetchMemberForPause(tenantId, memberId, db);
  if (!member) return { ok: false, error: 'Member not found' };
  if (!isMemberPaused(member)) {
    return { ok: true, alreadyResumed: true, warnings: [] };
  }

  const warnings = [];
  let gcSubscriptionIds = Array.isArray(member.membership_pause_gc_subscriptions)
    ? member.membership_pause_gc_subscriptions
    : [];
  // Fallback when pause failed to record the ids: resume the member's
  // active-ish plans' subscriptions (resuming a not-paused subscription is a
  // tolerated no-op).
  if (!gcSubscriptionIds.length) {
    const { data: plans } = await db
      .from('membership_payment_plans')
      .select('gocardless_subscription_id')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .not('gocardless_subscription_id', 'is', null)
      .in('status', PAUSABLE_PLAN_STATUSES);
    gcSubscriptionIds = (plans || []).map((p) => p.gocardless_subscription_id);
  }

  // 1) Clear pause state FIRST, guarded on still-paused so a concurrent
  //    resume (admin + cron) records side effects once. If this fails we
  //    stop before touching GoCardless, so payments can never restart while
  //    the member remains access-blocked.
  const { data: updated, error: updateError } = await db
    .from('member')
    .update({
      membership_paused: false,
      membership_paused_at: null,
      membership_pause_restart_date: null,
      membership_paused_by: null,
      membership_pause_reason: null,
      membership_pause_gc_subscriptions: [],
    })
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .eq('membership_paused', true)
    .select('id');
  if (updateError) {
    return { ok: false, error: `Failed to clear pause: ${updateError.message}` };
  }
  if (!updated?.length) {
    return { ok: true, alreadyResumed: true, warnings };
  }

  // 2) Resume the subscriptions the pause stopped. Failures are surfaced as
  //    warnings AND recorded in the note so a still-paused subscription is
  //    never silent.
  const gcResult = await resumeMemberGcSubscriptions({ tenantId, subscriptionIds: gcSubscriptionIds, gcFactory });
  warnings.push(...gcResult.warnings);

  // 3) Note the resume. Access is re-enabled implicitly because enforcement
  //    reads membership_paused; a member disabled via the manual login
  //    toggle stays disabled.
  const content = [
    auto
      ? '[Membership Resumed] Scheduled restart date reached — access and payments were automatically restored.'
      : '[Membership Resumed] Pause lifted — access and payments restored.',
    !auto && actorName ? `Resumed by: ${actorName}` : null,
    warnings.length ? `Warnings (may need manual GoCardless attention): ${warnings.join('; ')}` : null,
  ].filter(Boolean).join('\n');
  await insertPauseNote({ memberId, authorMemberId: actorMemberId, content, db });

  return { ok: true, warnings };
}

/**
 * Cron sweep: find paused members whose restart date has arrived (across all
 * tenants) and resume each idempotently. Safe pre-migration (empty result).
 */
export async function processPauseAutoRestarts(results, { db = defaultSupabase, gcFactory = gocardlessForTenant, now = new Date() } = {}) {
  if (!db) return;
  const todayStr = now.toISOString().slice(0, 10);
  const { data: dueMembers, error } = await db
    .from('member')
    .select('id, tenant_id, membership_pause_restart_date')
    .eq('membership_paused', true)
    .not('membership_pause_restart_date', 'is', null)
    .lte('membership_pause_restart_date', todayStr);
  if (error) {
    if (!isMissingColumnError(error)) {
      console.error('[MemberPause] auto-restart query failed:', error.message);
      if (results) {
        results.errors = (results.errors || 0) + 1;
        (results.details = results.details || []).push({ step: 'pause-auto-restart', status: 'error', reason: error.message });
      }
    }
    return;
  }
  for (const m of dueMembers || []) {
    try {
      const outcome = await resumeMember({ tenantId: m.tenant_id, memberId: m.id, auto: true, db, gcFactory });
      if (results) {
        results.details = results.details || [];
        if (outcome.ok && !outcome.alreadyResumed) {
          results.processed = (results.processed || 0) + 1;
          results.details.push({ tenantId: m.tenant_id, memberId: m.id, step: 'pause-auto-restart', status: 'processed', warnings: outcome.warnings });
        } else if (!outcome.ok) {
          results.errors = (results.errors || 0) + 1;
          results.details.push({ tenantId: m.tenant_id, memberId: m.id, step: 'pause-auto-restart', status: 'error', reason: outcome.error });
        }
      }
    } catch (err) {
      console.error(`[MemberPause] auto-restart failed for member ${m.id}:`, err.message);
      if (results) {
        results.errors = (results.errors || 0) + 1;
        (results.details = results.details || []).push({ tenantId: m.tenant_id, memberId: m.id, step: 'pause-auto-restart', status: 'error', reason: err.message });
      }
    }
  }
}
