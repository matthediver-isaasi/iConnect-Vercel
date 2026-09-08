import { supabase } from './database.js';

export function resolveEffectiveCpdRule(rules, ticketId, triggerType) {
  const active = (rules || []).filter(rule => rule.active !== false);
  const ticket = ticketId == null ? null : String(ticketId);
  // Ticket scope is an explicit override of the whole event configuration, not
  // merely an override for the rule's own trigger. This prevents a ticket with
  // (for example) an attendance-only setting from inheriting registration.
  const ticketRules = active.filter(rule => ticket != null
    && rule.ticket_id != null && String(rule.ticket_id) === ticket);
  if (ticketRules.length) {
    return ticketRules.find(rule => rule.is_no_award === true)
      || ticketRules.find(rule => rule.trigger_type === triggerType)
      || null;
  }
  return active.find(rule => rule.ticket_id == null && rule.trigger_type === triggerType) || null;
}

export function decideAttendanceEvidence(evidence) {
  if (!evidence) return { state: 'pending', qualifies: false, reason: 'evidence_unavailable' };
  if (evidence.type === 'qr_checkin') {
    if (evidence.checkInReversedAt) {
      const checked = new Date(evidence.checkedInAt).getTime();
      const reversed = new Date(evidence.checkInReversedAt).getTime();
      if (!Number.isFinite(checked) || !Number.isFinite(reversed) || checked <= reversed) {
        return { state: 'final', qualifies: false, reason: 'checkin_reversed' };
      }
    }
    return evidence.checkedInAt
      ? { state: 'final', qualifies: true }
      : { state: 'pending', qualifies: false, reason: 'checkin_not_present' };
  }
  if (!['zoom', 'teams'].includes(evidence.type)) {
    return { state: 'error', qualifies: false, reason: 'unsupported_provider' };
  }
  // Online transitions are immutable history, but their queued work can become
  // stale when a later reconciliation replaces the current outcome.
  if (evidence.currentMatchesQueued === false) {
    if (['below_threshold', 'absent'].includes(evidence.status)) {
      return { state: 'final', qualifies: false, reason: `outcome_${evidence.status}` };
    }
    return { state: 'pending', qualifies: false, reason: 'outcome_superseded_or_unresolved' };
  }
  if (!evidence.finalized) return { state: 'pending', qualifies: false, reason: 'outcome_not_finalized' };
  if (!['attended', 'below_threshold', 'absent'].includes(evidence.status)) {
    return { state: 'error', qualifies: false, reason: 'invalid_outcome_status' };
  }
  return {
    state: 'final',
    qualifies: evidence.status === 'attended',
    reason: evidence.status === 'attended' ? null : `outcome_${evidence.status || 'unknown'}`,
  };
}

export async function loadCurrentQrEvidence(db, {
  tenantId, bookingType, booking, evidenceId, snapshot = {},
}) {
  if (bookingType === 'booking') {
    if (String(evidenceId) !== String(booking.id)) {
      return { ...snapshot, type: 'qr_checkin', checkedInAt: null, invalid: true };
    }
    const result = await db.from('booking')
      .select('id,tenant_id,event_id,checked_in_at,check_in_reversed_at,check_in_reversal_reason')
      .eq('id', evidenceId).eq('tenant_id', tenantId).eq('event_id', booking.event_id)
      .maybeSingle();
    if (result.error) throw new Error(`Failed to reload QR evidence: ${result.error.message}`);
    if (!result.data) return { ...snapshot, type: 'qr_checkin', checkedInAt: null, invalid: true };
    return {
      ...snapshot, type: 'qr_checkin', checkinRecordId: result.data.id,
      checkedInAt: result.data.checked_in_at,
      checkInReversedAt: result.data.check_in_reversed_at,
      checkInReversalReason: result.data.check_in_reversal_reason,
      eventId: result.data.event_id,
    };
  }
  if (bookingType !== 'complex_event_booking') {
    return { ...snapshot, type: 'qr_checkin', checkedInAt: null, invalid: true };
  }
  const checkinResult = await db.from('complex_event_session_checkin')
    .select('id,tenant_id,complex_event_id,booking_id,session_id,checked_in_at,check_in_reversed_at,check_in_reversal_reason')
    .eq('id', evidenceId).eq('tenant_id', tenantId).eq('booking_id', booking.id)
    .eq('complex_event_id', booking.event_id).maybeSingle();
  if (checkinResult.error) throw new Error(`Failed to reload complex QR evidence: ${checkinResult.error.message}`);
  const checkin = checkinResult.data;
  if (!checkin) return { ...snapshot, type: 'qr_checkin', checkedInAt: null, invalid: true };
  const sessionResult = await db.from('complex_event_session').select('id')
    .eq('id', checkin.session_id).eq('tenant_id', tenantId)
    .eq('complex_event_id', booking.event_id).maybeSingle();
  if (sessionResult.error) throw new Error(`Failed to validate QR session: ${sessionResult.error.message}`);
  if (!sessionResult.data) return { ...snapshot, type: 'qr_checkin', checkedInAt: null, invalid: true };
  return {
    ...snapshot, type: 'qr_checkin', checkinRecordId: checkin.id,
    sessionId: checkin.session_id, complexEventId: checkin.complex_event_id,
    checkedInAt: checkin.checked_in_at,
    checkInReversedAt: checkin.check_in_reversed_at,
    checkInReversalReason: checkin.check_in_reversal_reason,
  };
}

export async function loadCurrentOnlineEvidence(db, {
  tenantId, bookingType, bookingId, evidence = {},
}) {
  const provider = evidence.type;
  const attendanceTargetId = evidence.attendanceTargetId;
  const revisionId = evidence.revisionId;
  if (!['zoom', 'teams'].includes(provider) || !attendanceTargetId || !revisionId) {
    return { ...evidence, finalized: false, currentMatchesQueued: false };
  }
  const result = await db.from('attendance_current_outcome')
    .select('outcome_revision_id,status')
    .eq('tenant_id', tenantId).eq('provider', provider)
    .eq('attendance_target_id', attendanceTargetId)
    .eq('booking_type', bookingType).eq('booking_id', bookingId)
    .maybeSingle();
  if (result.error) throw new Error(`Failed to reload online attendance evidence: ${result.error.message}`);
  const current = result.data;
  if (!current) return { ...evidence, finalized: false, currentMatchesQueued: false };
  const matches = String(current.outcome_revision_id) === String(revisionId)
    && current.status === evidence.status;
  const finalized = ['attended', 'below_threshold', 'absent'].includes(current.status);
  return {
    ...evidence,
    status: current.status,
    finalized,
    currentOutcomeRevisionId: current.outcome_revision_id,
    currentMatchesQueued: matches,
  };
}

async function loadBooking(db, tenantId, bookingType, bookingId) {
  if (!['booking', 'complex_event_booking'].includes(bookingType)) throw new Error('Invalid booking type');
  const { data, error } = await db.from(bookingType)
    .select('id,tenant_id,event_id,status,member_id,attendee_email,ticket_class_id,ticket_class_name')
    .eq('tenant_id', tenantId).eq('id', bookingId).maybeSingle();
  if (error) throw new Error(`Failed to load booking: ${error.message}`);
  // Complex registrations persist their authoritative ticket reference on
  // complex_event_booking.ticket_class_id (not on sessions or pricing JSON).
  return data;
}

export async function resolveMember(db, tenantId, booking) {
  const email = String(booking?.attendee_email || '').trim().toLowerCase();
  if (!email) return null;
  // ILIKE treats %, _ and \\ as pattern syntax. Escape them, then retain an
  // exact normalized comparison as a second guard.
  const escaped = email.replace(/[\\%_]/g, character => `\\${character}`);
  const result = await db.from('member').select('id,email').eq('tenant_id', tenantId)
    .ilike('email', escaped).limit(2);
  if (result.error) throw new Error(`Failed to resolve member: ${result.error.message}`);
  const exact = (result.data || []).filter(member =>
    String(member.email || '').trim().toLowerCase() === email);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  // member_id is frequently the purchaser. It is only an attendee hint after
  // its tenant member email has independently been proven equal.
  if (booking.member_id) {
    const hinted = await db.from('member').select('id,email').eq('tenant_id', tenantId)
      .eq('id', booking.member_id).maybeSingle();
    if (hinted.error) throw new Error(`Failed to validate booking member: ${hinted.error.message}`);
    if (String(hinted.data?.email || '').trim().toLowerCase() === email) return hinted.data.id;
  }
  return null;
}

export async function processCpdBadgeAward(input, { db = supabase } = {}) {
  const { tenantId, bookingType, bookingId, triggerType, idempotencyKey } = input;
  if (!db || !tenantId || !bookingId || !idempotencyKey) throw new Error('Incomplete CPD badge award request');
  const booking = await loadBooking(db, tenantId, bookingType, bookingId);
  const eventType = bookingType === 'booking' ? 'event' : 'complex_event';
  let status;
  let memberId = null;
  let evidence = input.evidence;
  let evidenceDecision = { state: 'final', qualifies: true };
  if (!booking || booking.status !== 'confirmed') status = 'skipped_cancelled';
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
  const attempt = {
    tenant_id: tenantId, idempotency_key: idempotencyKey, event_type: eventType,
    event_id: booking?.event_id || input.eventId, booking_type: bookingType, booking_id: bookingId,
    member_id: memberId, ticket_id: booking?.ticket_class_id || null,
    ticket_name_snapshot: booking?.ticket_class_name || null,
    trigger_type: triggerType, evidence_type: evidence?.type || null,
    evidence_id: input.evidenceId || null, evidence_snapshot: evidence || {},
    rule_id: null, badge_id: null,
    status: status || 'granted', detail: evidenceDecision.reason || null,
  };
  return rpc(db, 'record_event_cpd_badge_award', { p_attempt: attempt });
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

export async function processCpdBadgeOutbox(db = supabase, { limit = 25, maxAttempts = 8 } = {}) {
  const rows = await rpc(db, 'claim_event_cpd_badge_outbox', { p_limit: limit });
  const result = { claimed: rows?.length || 0, completed: 0, failed: 0 };
  for (const row of rows || []) {
    try {
      await processCpdBadgeAward({
        tenantId: row.tenant_id, bookingType: row.booking_type, bookingId: row.booking_id,
        triggerType: row.trigger_type, idempotencyKey: row.idempotency_key,
        evidenceId: row.evidence_id,
        evidence: row.evidence_type === 'qr_checkin'
          ? { type: 'qr_checkin', ...(row.evidence_snapshot || {}) }
          : { type: row.evidence_type, ...(row.evidence_snapshot || {}) },
      }, { db });
      await rpc(db, 'complete_event_cpd_badge_outbox', { p_id: row.id, p_lock_token: row.lock_token });
      result.completed++;
    } catch (error) {
      result.failed++;
      await rpc(db, 'fail_event_cpd_badge_outbox', {
        p_id: row.id, p_lock_token: row.lock_token,
        p_error: error?.message || String(error), p_max_attempts: maxAttempts,
      });
    }
  }
  return result;
}