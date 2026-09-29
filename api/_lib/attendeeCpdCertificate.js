import { createHash } from 'node:crypto';
import { resolveEventCpdCertificate } from './eventCpdCertificateRules.js';
import { renderCpdCertificatePdf } from './cpdCertificatePdf.js';
import { loadCpdEmailTemplate, prepareCpdEmail } from './eventCpdEmail.js';
import { prepareCertificateSurveyLinks } from './certificateSurveyGrants.js';
import { resolveMember, decideAttendanceEvidence } from './eventCpdBadgeService.js';
import { resolveEffectiveCpdPointsRule } from './eventCpdPointsService.js';

export const CERTIFICATE_BOOKINGS = { standard: 'booking', complex: 'complex_event_booking' };
export const certificateFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validCertificateRecipient = value => typeof value === 'string'
  && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value) && value.length <= 254;

async function one(db, table, tenantId, id) {
  const { data, error } = await db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// No sample/default value is certificate evidence. Required unknown fields must
// fail explicitly; optional unknown fields render blank, even if the designer
// supplied a default. Member points come only from the immutable booking ledger;
// guest certificate points are explicitly separate evidence, never an award.
export function realCertificatePlaceholders(placeholders, values) {
  const missing = (placeholders || []).filter(p => p.missing_policy === 'error'
    && (values[p.placeholder_key] == null || String(values[p.placeholder_key]).trim() === ''))
    .map(p => p.placeholder_key);
  return {
    missing: [...new Set(missing)],
    placeholders: (placeholders || []).map(({ sample_value, default_value, ...p }) => ({
      ...p, default_value: null,
      missing_policy: p.missing_policy === 'error' ? 'error' : 'blank',
    })),
  };
}

async function guestCertificatePoints(db, { tenantId, booking, bookingSource, eventType, ticketId }) {
  const { data: rules, error } = await db.from('event_cpd_points_rule').select('*')
    .eq('tenant_id', tenantId).eq('event_type', eventType === 'simple' ? 'event' : 'complex_event')
    .eq('event_id', booking.event_id).eq('active', true);
  if (error) throw error;
  // Resolve ticket precedence before trigger evaluation: an attendance-only
  // override must not inherit the event registration points.
  const scoped = (rules || []).filter(rule => rule.ticket_id != null && String(rule.ticket_id) === String(ticketId));
  const rule = scoped.length ? scoped[0] : (rules || []).find(rule => rule.ticket_id == null);
  const evidence = { rule_id: rule?.id || null, trigger: rule?.trigger_type || null,
    ticket_id: ticketId || null, source: 'guest_certificate_rule', qualifies: false };
  if (!rule || rule.is_no_award || rule.points_value == null || Number(rule.points_value) <= 0) return { evidence };
  // Use the shared precedence resolver as for member awards; no alternate
  // fallback to the event-wide rule for this ticket is permitted.
  if (resolveEffectiveCpdPointsRule(rules, ticketId, rule.trigger_type)?.id !== rule.id) return { evidence };
  if (booking.status !== 'confirmed') return { evidence };
  if (rule.trigger_type === 'registration') {
    return { points: String(rule.points_value), evidence: { ...evidence, qualifies: true, type: 'confirmed_booking', id: booking.id } };
  }
  if (rule.trigger_type !== 'attendance') return { evidence };
  let attendance = null;
  if (bookingSource === 'standard') {
    const decision = decideAttendanceEvidence({ type: 'qr_checkin', checkedInAt: booking.checked_in_at,
      checkInReversedAt: booking.check_in_reversed_at });
    if (decision.qualifies) attendance = { type: 'qr_checkin', id: booking.id, checked_in_at: booking.checked_in_at,
      reversed_at: booking.check_in_reversed_at || null };
  } else {
    const { data: checkins, error: checkinError } = await db.from('complex_event_session_checkin')
      .select('id,session_id,checked_in_at,check_in_reversed_at')
      .eq('tenant_id', tenantId).eq('complex_event_id', booking.event_id).eq('booking_id', booking.id)
      .order('id');
    if (checkinError) throw checkinError;
    for (const checkin of checkins || []) {
      if (!decideAttendanceEvidence({ type: 'qr_checkin', checkedInAt: checkin.checked_in_at,
        checkInReversedAt: checkin.check_in_reversed_at }).qualifies) continue;
      const { data: session, error: sessionError } = await db.from('complex_event_session').select('id')
        .eq('tenant_id', tenantId).eq('complex_event_id', booking.event_id).eq('id', checkin.session_id).maybeSingle();
      if (sessionError) throw sessionError;
      if (session) {
        attendance = { type: 'qr_checkin', id: checkin.id, session_id: session.id,
          checked_in_at: checkin.checked_in_at, reversed_at: checkin.check_in_reversed_at || null };
        break;
      }
    }
  }
  if (!attendance) {
    const { data: outcomes, error: outcomeError } = await db.from('attendance_current_outcome')
      .select('provider,status,outcome_revision_id,attendance_target_id')
      .eq('tenant_id', tenantId).eq('booking_type', CERTIFICATE_BOOKINGS[bookingSource])
      .eq('booking_id', booking.id).eq('status', 'attended')
      .order('attendance_target_id');
    if (outcomeError) throw outcomeError;
    for (const outcome of outcomes || []) {
      if (!['zoom', 'teams'].includes(outcome.provider) || !outcome.outcome_revision_id) continue;
      const { data: target, error: targetError } = await db.from('attendance_target')
        .select('id,tracking_enabled').eq('tenant_id', tenantId).eq('event_id', booking.event_id)
        .eq('id', outcome.attendance_target_id).maybeSingle();
      if (targetError) throw targetError;
      if (target && target.tracking_enabled !== false) {
        attendance = { type: outcome.provider, id: outcome.outcome_revision_id,
          target_id: target.id, status: outcome.status };
        break;
      }
    }
  }
  return attendance
    ? { points: String(rule.points_value), evidence: { ...evidence, qualifies: true, ...attendance } }
    : { evidence };
}

export async function resolveAttendeeCertificate(db, { tenantId, bookingId, bookingSource, memberCertificateId = null }) {
  const booking = await one(db, CERTIFICATE_BOOKINGS[bookingSource], tenantId, bookingId);
  if (!booking) throw Object.assign(new Error('Attendee booking not found'), { status: 404 });
  const eventType = bookingSource === 'complex' ? 'complex' : 'simple';
  const event = await one(db, eventType === 'complex' ? 'complex_event' : 'event', tenantId, booking.event_id);
  if (!event) throw Object.assign(new Error('Event not found'), { status: 404 });
  // The booking member_id can be the purchaser of another person's ticket.
  const attendeeMemberId = await resolveMember(db, tenantId, booking);
  if (memberCertificateId && String(attendeeMemberId) !== String(memberCertificateId)) {
    return { available: false, reason: 'This award does not belong to the booking attendee.' };
  }
  const member = attendeeMemberId ? await one(db, 'member', tenantId, attendeeMemberId) : null;
  const firstName = booking.attendee_first_name || member?.first_name || '';
  const lastName = booking.attendee_last_name || member?.last_name || '';
  const attendeeName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const recipient = typeof booking.attendee_email === 'string' ? booking.attendee_email.trim() : '';
  const base = { attendee_name: attendeeName, recipient, event_name: event.title || '', available: false,
    can_send: false, fingerprint: null, reason: null, send_reason: null };
  if (['cancelled', 'canceled', 'transferred', 'refunded'].includes(booking.status)) {
    return { ...base, reason: 'This booking is cancelled, transferred or refunded.' };
  }
  let ticketId = booking.ticket_class_id;
  if (ticketId == null || ticketId === '') {
    let tickets = event.pricing_config?.ticket_classes || [];
    if (eventType === 'complex') {
      const result = await db.from('complex_event_ticket_class').select('id,name')
        .eq('tenant_id', tenantId).eq('complex_event_id', event.id);
      if (result.error) throw result.error;
      tickets = result.data || [];
    }
    // Legacy bookings sometimes have only a ticket name. Only an unambiguous
    // match may select its stable rule ID; never bypass a suppression/override.
    const matches = tickets.filter(ticket => ticket.name === booking.ticket_class_name);
    if (matches.length === 1) ticketId = matches[0].id;
    else if (tickets.length || booking.ticket_class_name) {
      return { ...base, reason: 'The booked ticket cannot be identified unambiguously. Correct its ticket reference first.' };
    }
  }
  let policy;
  try {
    policy = await resolveEventCpdCertificate(db, {
      tenantId, eventType, eventId: booking.event_id, ticketId,
    });
  } catch (error) {
    if (error.message === 'Ticket does not belong to event') {
      return { ...base, reason: 'The booked ticket no longer belongs to this event.' };
    }
    throw error;
  }
  if (!policy.available) return { ...base, reason: `Certificate unavailable: ${policy.reason.replaceAll('_', ' ')}.` };
  const template = await one(db, 'cpd_certificate_template', tenantId, policy.template_id);
  if (!template || template.status !== 'active' || template.source_bucket !== 'private-uploads'
    || !template.source_path?.startsWith(`${tenantId}/`)) {
    return { ...base, reason: 'The active tenant-private certificate template is unavailable.' };
  }
  const { data: fields, error } = await db.from('cpd_certificate_placeholder').select('*')
    .eq('tenant_id', tenantId).eq('template_id', template.id)
    .order('page_number').order('display_order').order('id');
  if (error) throw error;
  const organisation = booking.organization_id ? await one(db, 'organization', tenantId, booking.organization_id) : null;
  const values = {
    ...policy.placeholders,
    'member.full_name': attendeeName, 'member.first_name': firstName, 'member.last_name': lastName,
    'member.email': recipient, 'member.membership_number': member?.membership_number || member?.member_number || '',
    'attendee.full_name': attendeeName, 'attendee.first_name': firstName, 'attendee.last_name': lastName,
    'attendee.email': recipient,
    'organisation.name': organisation?.name || booking.guest_organisation_name || booking.attendee_organization || '',
    'cpd.activity_title': event.title || '', 'event.name': event.title || '',
    'event.start_date': event.start_date || '', 'event.end_date': event.end_date || '',
  };
  let pointsRows = [];
  let guestPointsEvidence = null;
  const emailSelection = memberCertificateId ? null : await loadCpdEmailTemplate(db, tenantId, policy.email_template_id);
  if (memberCertificateId || !attendeeMemberId || (fields || []).some(p => p.placeholder_key === 'cpd.cpd_points')
    || /\{\{\s*cpd_points\s*\}\}|\[\[\s*cpd_points\s*\]\]/.test(`${emailSelection.template?.subject || ''} ${emailSelection.template?.body || ''}`)) {
    if (attendeeMemberId) {
      // Matched members never receive speculative rule points for missing awards.
      // Paginate even when a deployment's REST row cap is below 500.
      for (let offset = 0; ; ) {
        const result = await db.from('member_cpd_points_ledger').select('id,member_id,points_value,entry_kind')
          .eq('tenant_id', tenantId).eq('booking_type', CERTIFICATE_BOOKINGS[bookingSource])
          .eq('booking_id', bookingId).eq('event_id', booking.event_id).eq('member_id', attendeeMemberId)
          .eq('event_type', eventType === 'simple' ? 'event' : 'complex_event')
          .order('id').range(offset, offset + 499);
        if (result.error) throw result.error;
        if (!result.data?.length) break;
        pointsRows.push(...result.data);
        offset += result.data.length;
      }
    } else {
      const result = await guestCertificatePoints(db, { tenantId, booking, bookingSource, eventType, ticketId });
      guestPointsEvidence = result.evidence;
      if (result.points != null) values['cpd.cpd_points'] = result.points;
    }
    if (pointsRows.length) {
      const points = pointsRows.reduce((sum, row) => sum + Number(row.points_value), 0);
      if (!Number.isFinite(points)) throw new Error('The authoritative CPD points ledger contains invalid values');
      values['cpd.cpd_points'] = points;
    }
  }
  const real = realCertificatePlaceholders(fields, values);
  if (!attendeeName || real.missing.length) return { ...base, reason: !attendeeName
    ? 'The attendee name is missing.' : `Required certificate data is unavailable: ${real.missing.join(', ')}.` };
  if (memberCertificateId) {
    // Self-service downloads are PDF-only; never prepare email, survey grants
    // or guest rule points. Bind the rendered values to the booking ledger.
    const fingerprint = certificateFingerprint({
      bookingId, bookingSource, attendeeMemberId, template: template.source_sha256,
      values, placeholders: real.placeholders, pointsRows,
    });
    return { ...base, available: true, fingerprint, template_name: template.name,
      template, placeholders: real.placeholders, values };
  }
  const emailValues = {
    attendee_name: attendeeName, attendee_first_name: firstName, attendee_last_name: lastName,
    attendee_email: recipient, organisation_name: values['organisation.name'], event_name: event.title || '',
    activity_date: values['cpd.activity_date'], activity_date_range: values['cpd.activity_date_range'],
    activity_start_date: values['cpd.activity_start_date'], activity_end_date: values['cpd.activity_end_date'],
    cpd_points: values['cpd.cpd_points'],
  };
  const usesSurveyList = /\{\{\s*event_survey_list\s*\}\}|\[\[\s*event_survey_list\s*\]\]/i
    .test(emailSelection.template?.body || '');
  let surveyList = null;
  if (usesSurveyList && validCertificateRecipient(recipient)) {
    const { data: tenant, error: tenantError } = await db.from('tenant').select('id,slug,domain')
      .eq('id', tenantId).maybeSingle();
    if (tenantError || !tenant) throw tenantError || new Error('Certificate tenant unavailable');
    surveyList = await prepareCertificateSurveyLinks({
      db, tenant, eventType: eventType === 'simple' ? 'event' : 'complex_event',
      eventId: booking.event_id, bookingSource, bookingId, recipient, preview: true,
    });
  }
  const email = await prepareCpdEmail(db, tenantId, emailSelection, emailValues, surveyList);
  const provenance = { ...policy.provenance, booking_id: bookingId, booking_source: bookingSource,
    booking_status: booking.status, attendee_member_id: attendeeMemberId || null,
    template_version: template.version, template_source_sha256: template.source_sha256,
    points_ledger: pointsRows, guest_certificate_points_evidence: guestPointsEvidence,
    values, placeholders: real.placeholders,
    email: { selection_id: policy.email_template_id || null, ...email.provenance,
      rendered_message: email.message || null, survey_snapshot: surveyList?.snapshot || null,
      reason: email.reason || null } };
  const fingerprint = certificateFingerprint({ provenance, recipient, source_path: template.source_path });
  return { ...base, available: true, can_send: validCertificateRecipient(recipient) && !email.reason, fingerprint,
    certificate_points: guestPointsEvidence?.qualifies ? values['cpd.cpd_points'] : null,
    certificate_points_source: guestPointsEvidence ? 'guest_rule' : pointsRows.length ? 'member_ledger' : null,
    email_template_id: policy.email_template_id || null, email_template_name: emailSelection.template?.name || null,
    email_is_default: !policy.email_template_id, email_reason: email.reason || null, email_message: email.message,
    email_selection_missing: policy.email_selection_missing,
    email_values: emailValues, email_selection: emailSelection, survey_list: surveyList,
    survey_list_enabled: usesSurveyList, event_id: booking.event_id,
    send_reason: email.reason || (validCertificateRecipient(recipient) ? null : 'The attendee booking has no valid email address.'),
    template_name: template.name, template, placeholders: real.placeholders, values, provenance };
}

export async function renderAttendeeCertificate(db, resolved) {
  const { data, error } = await db.storage.from('private-uploads').download(resolved.template.source_path);
  if (error || !data) throw new Error('The private certificate PDF could not be read');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (!resolved.template.source_sha256 || createHash('sha256').update(bytes).digest('hex') !== resolved.template.source_sha256) {
    throw new Error('Certificate source changed. Reload the certificate details.');
  }
  return renderCpdCertificatePdf(bytes, resolved.placeholders, resolved.values);
}