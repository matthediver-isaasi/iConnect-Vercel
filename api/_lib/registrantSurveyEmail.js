import { createHash } from 'node:crypto';
import { assignmentWindowState } from './surveyAssignment.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { surveyLifecycleState } from './surveyLifecycleState.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';
import { resolveInheritedPolicy } from './attendancePolicy.js';

const checked = result => { if (result.error) throw new Error('Survey or attendance details could not be verified. Please retry.'); return result.data; };
export const escapeSurveyEmail = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const surveyEmailFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function surveyAcceptsResponses(form, assignment, published) {
  return !!(form && form.form_type === 'survey' && form.is_active
    && surveyLifecycleState(form) === 'active' && isFormScheduleAvailable(form)
    && assignmentWindowState(assignment) === 'open' && assignment.token && published);
}

// Resolve from source policy too: absence of a materialized attendance target
// does not mean that attendance controls were never configured.
export async function loadRegistrantSurveyEvent(db, tenantId, eventId, source) {
  const complex = source === 'complex';
  const event = checked(await db.from(complex ? 'complex_event' : 'event').select('*')
    .eq('tenant_id', tenantId).eq('id', eventId).maybeSingle());
  if (!event) throw new Error('Event unavailable.');
  const targets = checked(await db.from('attendance_target').select('id,tracking_enabled')
    .eq('tenant_id', tenantId).eq('event_id', eventId));
  const children = checked(await db.from(complex ? 'complex_event_session' : 'event_agenda_item').select('*')
    .eq('tenant_id', tenantId).eq(complex ? 'complex_event_id' : 'event_id', eventId));
  if (targets.length >= 1000 || children.length >= 1000) throw new Error('Attendance configuration is too large to verify safely.');
  const onlineTracking = !!event.attendance_tracking_enabled
    || targets.length > 0
    || children.some(child => resolveInheritedPolicy(event, child).enabled);
  // In-person bookings have the existing QR/check-in facility.
  const qrTracking = complex ? children.some(child => child.is_online !== true) : event.is_online !== true;
  const assignments = checked(await db.from('event_survey_assignment').select('*')
    .eq('tenant_id', tenantId).eq(complex ? 'complex_event_id' : 'event_id', eventId).eq('status', 'active'));
  const surveys = [];
  if (assignments.length >= 1000) throw new Error('Survey assignments could not be fully verified.');
  for (const assignment of assignments) {
    const form = checked(await db.from('form').select('*').eq('tenant_id', tenantId).eq('id', assignment.form_id).maybeSingle());
    const version = Number(form?.survey_settings?.current_version);
    const published = Number.isInteger(version) && version > 0
      ? checked(await db.from('survey_version').select('id').eq('tenant_id', tenantId)
        .eq('form_id', assignment.form_id).eq('version_number', version).maybeSingle()) : null;
    if (surveyAcceptsResponses(form, assignment, published)) surveys.push({
      id: assignment.id, name: form.name, token: assignment.token,
      requires_login: assignment.access_mode === 'authenticated',
    });
  }
  return { event, children, targets, surveys, tracking: onlineTracking || qrTracking };
}

export async function resolveRegistrantSurveyEmail(db, tenantId, input) {
  const source = input.booking_source;
  const booking = checked(await db.from(source === 'complex' ? 'complex_event_booking' : 'booking').select('*')
    .eq('tenant_id', tenantId).eq('id', input.booking_id).maybeSingle());
  if (!booking || booking.status !== 'confirmed') throw new Error('Only confirmed registrations can receive a survey invitation.');
  const eventId = booking.event_id || booking.complex_event_id;
  const context = await loadRegistrantSurveyEvent(db, tenantId, eventId, source);
  const survey = context.surveys.find(row => row.id === input.assignment_id);
  if (!survey) throw new Error('This survey is no longer open for responses. Reload the survey choices.');
  let attended = !!booking.checked_in_at;
  if (source === 'complex') {
    const checkins = checked(await db.from('complex_event_session_checkin').select('checked_in_at,session_id')
      .eq('tenant_id', tenantId).eq('booking_id', booking.id));
    attended ||= checkins.some(row => !!row.checked_in_at
      && context.children.some(session => session.id === row.session_id && session.is_online !== true));
  }
  const activeTargetIds = new Set(context.targets.filter(t => t.tracking_enabled !== false).map(t => t.id));
  const outcomes = checked(await db.from('attendance_current_outcome').select('attendance_target_id,status,outcome_revision_id,provider')
    .eq('tenant_id', tenantId).eq('booking_id', booking.id)
    .eq('booking_type', source === 'complex' ? 'complex_event_booking' : 'booking'));
  attended ||= outcomes.some(row => activeTargetIds.has(row.attendance_target_id) && row.status === 'attended'
    && row.outcome_revision_id && ['zoom', 'teams'].includes(row.provider));
  const tracking = context.tracking || !!booking.check_in_token;
  if (tracking && !attended) throw new Error('Attendance has not been verified for this registrant. A survey invitation cannot be sent.');
  const recipient = String(booking.attendee_email || '').trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) throw new Error('The registrant does not have a valid email address.');
  const tenant = checked(await db.from('tenant').select('name,slug,domain').eq('id', tenantId).maybeSingle());
  if (!tenant?.slug) throw new Error('The event organisation could not be verified.');
  const url = `${getTenantTrustedBaseUrl(null, tenant)}/survey/${encodeURIComponent(survey.token)}`;
  const name = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'attendee';
  const subject = `Share your feedback: ${context.event.title}`.replace(/[\r\n]/g, ' ');
  const text = `Hello ${name},\n\nPlease share your feedback on ${context.event.title} by completing ${survey.name}.\n\n${url}\n\n${survey.requires_login ? 'Please sign in with your member account to respond.\n\n' : ''}Thank you,\n${tenant.name || 'The events team'}`;
  const e = escapeSurveyEmail;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>Hello ${e(name)},</p><p>Please share your feedback on <strong>${e(context.event.title)}</strong> by completing ${e(survey.name)}.</p><p><a href="${e(url)}">Complete the survey</a></p>${survey.requires_login ? '<p>Please sign in with your member account to respond.</p>' : ''}<p>Thank you,<br>${e(tenant.name || 'The events team')}</p></div>`;
  return { recipient, subject, html, text, attendance_verified: attended, attendance_warning: !tracking,
    fingerprint: surveyEmailFingerprint({ recipient, subject, html, tracking, attended, assignment: survey.id }) };
}
