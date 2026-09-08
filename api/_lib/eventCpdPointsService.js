import { supabase } from './database.js';
import {
  decideAttendanceEvidence,
  loadCurrentOnlineEvidence,
  loadCurrentQrEvidence,
  resolveMember,
} from './eventCpdBadgeService.js';

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

export class RetryableCpdPointsOutcomeError extends Error {
  constructor(result) {
    super(`CPD points outcome remains ${result?.status || 'unresolved'}`);
    this.name = 'RetryableCpdPointsOutcomeError';
    this.outcome = result;
  }
}

async function loadBooking(db, tenantId, bookingType, bookingId) {
  if (!['booking', 'complex_event_booking'].includes(bookingType)) {
    throw new Error('Invalid booking type');
  }
  const { data, error } = await db.from(bookingType)
    .select('id,tenant_id,event_id,status,member_id,attendee_email,ticket_class_id,ticket_class_name')
    .eq('tenant_id', tenantId).eq('id', bookingId).maybeSingle();
  if (error) throw new Error(`Failed to load booking: ${error.message}`);
  return data;
}

export function resolveEffectiveCpdPointsRule(rules, ticketId, triggerType) {
  const active = (rules || []).filter(rule => rule.active !== false);
  const ticket = ticketId == null ? null : String(ticketId);
  const overrides = active.filter(rule => ticket != null
    && rule.ticket_id != null && String(rule.ticket_id) === ticket);
  if (overrides.length) {
    return overrides.find(rule => rule.is_no_award === true)
      || overrides.find(rule => rule.trigger_type === triggerType)
      || null;
  }
  return active.find(rule => rule.ticket_id == null && rule.trigger_type === triggerType) || null;
}

export async function processCpdPointsAward(input, { db = supabase } = {}) {
  const { tenantId, bookingType, bookingId, triggerType, idempotencyKey } = input;
  if (!db || !tenantId || !bookingId || !idempotencyKey) {
    throw new Error('Incomplete CPD points award request');
  }
  const booking = await loadBooking(db, tenantId, bookingType, bookingId);
  const eventType = bookingType === 'booking' ? 'event' : 'complex_event';
  let status;
  let memberId = null;
  let evidence = input.evidence;
  let evidenceDecision = { state: 'final', qualifies: true };

  // A missing tenant-scoped booking is deliberately still sent to the
  // transactional RPC, which distinguishes and audits cross-tenant input.
  if (booking) {
    if (booking.status !== 'confirmed') status = 'skipped_cancelled';
    else {
      memberId = await resolveMember(db, tenantId, booking);
      if (!memberId) status = 'skipped_unmatched';
      if (!status && triggerType === 'attendance') {
        if (evidence?.type === 'qr_checkin') {
          evidence = await loadCurrentQrEvidence(db, {
            tenantId, bookingType, booking, evidenceId: input.evidenceId, snapshot: evidence,
          });
        } else if (['zoom', 'teams'].includes(evidence?.type)) {
          evidence = await loadCurrentOnlineEvidence(db, {
            tenantId, bookingType, bookingId, evidence,
          });
        }
        evidenceDecision = decideAttendanceEvidence(evidence);
        if (evidenceDecision.state === 'pending') status = 'pending_evidence';
        else if (evidenceDecision.state === 'error') status = 'error';
        else if (!evidenceDecision.qualifies) status = 'skipped_not_qualifying';
      }
    }
  }

  const result = await rpc(db, 'record_event_cpd_points_award', {
    p_attempt: {
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      event_type: eventType,
      event_id: booking?.event_id || input.eventId || null,
      booking_type: bookingType,
      booking_id: bookingId,
      member_id: memberId,
      ticket_id: booking?.ticket_class_id || null,
      ticket_name_snapshot: booking?.ticket_class_name || null,
      trigger_type: triggerType,
      evidence_type: evidence?.type || null,
      evidence_id: input.evidenceId || null,
      evidence_snapshot: evidence || {},
      status: status || 'awarded',
      detail: evidenceDecision.reason || null,
    },
  });
  // These are durable attempt outcomes, but not terminal delivery outcomes.
  // Leaving the outbox retryable lets current evidence or corrected data
  // recover while the occurrence-level unique key remains exactly-once.
  if (['pending_evidence', 'error'].includes(result?.status)) {
    throw new RetryableCpdPointsOutcomeError(result);
  }
  return result;
}

export async function processCpdPointsOutbox(db = supabase, { limit = 25, maxAttempts = 8 } = {}) {
  const rows = await rpc(db, 'claim_event_cpd_points_outbox', { p_limit: limit });
  const result = { claimed: rows?.length || 0, completed: 0, failed: 0 };
  for (const row of rows || []) {
    try {
      await processCpdPointsAward({
        tenantId: row.tenant_id,
        bookingType: row.booking_type,
        bookingId: row.booking_id,
        triggerType: row.trigger_type,
        idempotencyKey: row.idempotency_key,
        evidenceId: row.evidence_id,
        evidence: row.evidence_type === 'qr_checkin'
          ? { type: 'qr_checkin', ...(row.evidence_snapshot || {}) }
          : { type: row.evidence_type, ...(row.evidence_snapshot || {}) },
      }, { db });
      await rpc(db, 'complete_event_cpd_points_outbox', {
        p_id: row.id, p_lock_token: row.lock_token,
      });
      result.completed++;
    } catch (error) {
      result.failed++;
      await rpc(db, 'fail_event_cpd_points_outbox', {
        p_id: row.id,
        p_lock_token: row.lock_token,
        p_error: error?.message || String(error),
        p_max_attempts: maxAttempts,
      });
    }
  }
  return result;
}
