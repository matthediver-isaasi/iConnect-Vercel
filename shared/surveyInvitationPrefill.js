// Invitation authority is confined to the confirmed attendee booking. A booking's
// member_id/organization_id identifies its purchaser, NOT necessarily its attendee.
const BOOKING_SCALARS = new Set([
  'attendee_email', 'attendee_first_name', 'attendee_last_name', 'attendee_phone',
  'attendee_job_title', 'attendee_organization', 'guest_organisation_name',
  'booking_reference', 'ticket_class_name',
]);
const ATTENDEE_ALIASES = {
  first_name: 'attendee_first_name', last_name: 'attendee_last_name',
  email: 'attendee_email', phone: 'attendee_phone', job_title: 'attendee_job_title',
};

export function buildSurveyInvitationPrefill(fields, booking, settings = {}) {
  const values = {};
  const unavailable = [];
  const source = settings?.invitation_prefill_config?.source;
  for (const field of fields || []) {
    if (!field?.id || ['__proto__', 'constructor', 'prototype'].includes(field.id)) continue;
    const mapping = field.prefill_field;
    let key;
    let fullName = false;
    let reason;
    if (mapping) {
      if (mapping.startsWith('booking:')) key = mapping.slice(8);
      else if (mapping.startsWith('member:')) {
        key = ATTENDEE_ALIASES[mapping.slice(7)];
        if (!key) reason = 'attendee_link_unavailable';
      } else if (!mapping.includes(':') && source === 'booking') key = mapping;
      else if (!mapping.includes(':') && source === 'member') {
        key = ATTENDEE_ALIASES[mapping];
        if (!key) reason = 'attendee_link_unavailable';
      } else reason = mapping.includes(':') ? 'attendee_link_unavailable' : 'published_source_unavailable';
    } else {
      // Exact legacy identity labels only; explicit configured mappings always win.
      const label = String(field.label || '').trim().toLowerCase();
      if (['email', 'user_email'].includes(field.type) || label === 'email') key = 'attendee_email';
      else if (['first_name', 'user_first_name'].includes(field.type) || label === 'first name') key = 'attendee_first_name';
      else if (['last_name', 'user_last_name'].includes(field.type) || label === 'last name') key = 'attendee_last_name';
      else if (field.type === 'user_name' || label === 'full name') fullName = true;
      else if (['organisation_dropdown', 'organization_dropdown', 'organisation_group_dropdown'].includes(field.type)) {
        reason = 'attendee_link_unavailable';
      } else continue;
    }
    if (key && !BOOKING_SCALARS.has(key)) reason = 'unsupported_booking_mapping';
    const value = reason ? undefined : fullName
      ? [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ')
      : booking[key];
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') {
      values[field.id] = value;
    } else unavailable.push({ field_id: field.id, reason: reason || 'booking_value_unavailable' });
  }
  return { values, unavailable };
}

// Defaults, restored drafts, and even deliberately cleared user edits win.
export function mergeSurveyInvitationPrefill(previous, payload, fields, protectedIds = []) {
  const protectedSet = new Set(protectedIds);
  const allowed = new Set((fields || []).map(field => field.id));
  const next = { ...previous };
  for (const [id, value] of Object.entries(payload?.values || {})) {
    if (!allowed.has(id) || protectedSet.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
    if (previous[id] === undefined || previous[id] === null || previous[id] === '') next[id] = value;
  }
  return next;
}