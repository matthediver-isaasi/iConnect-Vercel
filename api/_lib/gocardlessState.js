// GoCardless Phase 1 — canonical status vocabulary + shared transition helper.
//
// The same vocabulary is used on membership_billing_agreements and
// membership_payment_plans. Every status change goes through
// applyStatusTransition() which:
//   - refuses invalid transitions (out-of-order webhook protection)
//   - is a no-op when the status is unchanged (duplicate protection)
//   - writes a membership_payment_status_history row on every real change
//
// Dependency-injectable `db` (supabase-shaped) for tests.

import { supabase } from './database.js';

export const STATUS = Object.freeze({
  PAYMENT_SETUP_REQUIRED: 'payment_setup_required',
  MANDATE_PENDING: 'mandate_pending',
  FIRST_PAYMENT_PENDING: 'first_payment_pending',
  ACTIVE: 'active',
  PAYMENT_GRACE_PERIOD: 'payment_grace_period',
  PAYMENT_OVERDUE: 'payment_overdue',
  PAYMENT_PLAN_CANCELLED: 'payment_plan_cancelled',
  EXPIRED: 'expired',
});

export const ALL_STATUSES = Object.freeze(Object.values(STATUS));

// Allowed transitions. Key = from, value = set of allowed to-statuses.
// Anything not listed is rejected (returned as { applied: false }) so a
// late/out-of-order webhook can never regress state — with deliberate
// exceptions for recovery (grace/overdue -> active) and cancellation
// (allowed from everywhere).
const TRANSITIONS = {
  [STATUS.PAYMENT_SETUP_REQUIRED]: new Set([
    STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE,
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.MANDATE_PENDING]: new Set([
    STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE,
    STATUS.PAYMENT_SETUP_REQUIRED, // mandate failed/cancelled before activation
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.FIRST_PAYMENT_PENDING]: new Set([
    STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE,
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.ACTIVE]: new Set([
    STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE,
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.PAYMENT_GRACE_PERIOD]: new Set([
    STATUS.ACTIVE, STATUS.PAYMENT_OVERDUE,
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.PAYMENT_OVERDUE]: new Set([
    STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD,
    STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED,
  ]),
  [STATUS.PAYMENT_PLAN_CANCELLED]: new Set([]),
  [STATUS.EXPIRED]: new Set([]),
};

export function canTransition(fromStatus, toStatus) {
  if (!ALL_STATUSES.includes(toStatus)) return false;
  if (fromStatus === toStatus) return false;
  if (!fromStatus) return true; // fresh rows
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed) return true; // unknown legacy status — allow repair
  return allowed.has(toStatus);
}

const ENTITY_TABLES = {
  billing_agreement: 'membership_billing_agreements',
  payment_plan: 'membership_payment_plans',
};

/**
 * Apply a status transition to a billing agreement or payment plan.
 *
 * @param {Object} args
 * @param {'billing_agreement'|'payment_plan'} args.entityType
 * @param {string} args.entityId
 * @param {string} args.toStatus - canonical status
 * @param {string} [args.reason]
 * @param {'webhook'|'reconciliation'|'system'} [args.source]
 * @param {string} [args.eventId] - GoCardless event id (webhook source)
 * @param {Object} [args.extraUpdate] - additional columns to set alongside status
 * @param {Object} [deps] - { db } test injection
 * @returns {Promise<{applied: boolean, fromStatus: string|null, toStatus: string, skippedReason?: string}>}
 */
export async function applyStatusTransition(
  { entityType, entityId, toStatus, reason = null, source = 'system', eventId = null, extraUpdate = {} },
  deps = {},
) {
  const db = deps.db || supabase;
  const table = ENTITY_TABLES[entityType];
  if (!table) throw new Error(`Unknown entityType: ${entityType}`);
  if (!entityId) throw new Error('entityId is required');
  if (!ALL_STATUSES.includes(toStatus)) throw new Error(`Unknown status: ${toStatus}`);

  const { data: row, error: rowErr } = await db
    .from(table)
    .select('id, tenant_id, status')
    .eq('id', entityId)
    .maybeSingle();
  if (rowErr) throw new Error(`Failed to load ${table}#${entityId}: ${rowErr.message}`);
  if (!row) return { applied: false, fromStatus: null, toStatus, skippedReason: 'row-not-found' };

  const fromStatus = row.status || null;
  if (fromStatus === toStatus) {
    return { applied: false, fromStatus, toStatus, skippedReason: 'no-change' };
  }
  if (!canTransition(fromStatus, toStatus)) {
    return { applied: false, fromStatus, toStatus, skippedReason: `invalid-transition:${fromStatus}->${toStatus}` };
  }

  // Guarded update: only flip if the status is still what we read, so two
  // concurrent webhook deliveries can't both "win".
  const update = { ...extraUpdate, status: toStatus, updated_at: new Date().toISOString() };
  let updateQuery = db.from(table).update(update).eq('id', entityId);
  updateQuery = fromStatus === null
    ? updateQuery.is('status', null)
    : updateQuery.eq('status', fromStatus);
  const { data: updated, error: upErr } = await updateQuery.select('id');
  if (upErr) throw new Error(`Failed to update ${table}#${entityId}: ${upErr.message}`);
  if (!updated || updated.length === 0) {
    return { applied: false, fromStatus, toStatus, skippedReason: 'concurrent-update' };
  }

  const { error: histErr } = await db.from('membership_payment_status_history').insert({
    tenant_id: row.tenant_id,
    entity_type: entityType,
    entity_id: entityId,
    from_status: fromStatus,
    to_status: toStatus,
    reason,
    source,
    event_id: eventId,
  });
  if (histErr) {
    // Loud but non-fatal — the state change itself succeeded.
    console.error(`[gocardlessState] failed to write status history for ${entityType}#${entityId}: ${histErr.message}`);
  }

  console.log(`[gocardlessState] ${entityType}#${entityId} ${fromStatus} -> ${toStatus} (source=${source}${eventId ? `, event=${eventId}` : ''})`);
  return { applied: true, fromStatus, toStatus };
}
