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

export const INVITATION_MEMBER_FIELDS = new Set([
  'first_name', 'last_name', 'full_name', 'middle_name', 'email', 'phone', 'mobile', 'landline', 'job_title', 'show_in_directory',
  'title', 'country', 'city', 'county', 'postcode', 'address_line_1', 'address_line_2',
  'organization_id', 'organization_group_id',
]);
export const INVITATION_ORG_FIELDS = new Set([
  'name', 'description', 'phone', 'website_url', 'invoicing_email', 'invoicing_address',
  'logo_url', 'tags', 'organization_group_id',
]);
const safeKey = key => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);

// Only these persisted mapping dialects are supported. No client supplied IDs.
export function invitationMapping(field, settings = {}) {
  const source = settings?.invitation_prefill_config?.source;
  const raw = field?.prefill_field;
  if (typeof raw === 'string' && raw) {
    const parts = raw.split(':');
    let kind = parts.length === 1 ? source : parts[0];
    const key = parts.length === 1 ? raw : parts[1];
    if (parts.length > 2 || !safeKey(key)) return null;
    if (kind === 'organization') kind = 'org';
    if (kind === 'custom') kind = source === 'member' ? 'member_custom' : source === 'organization' ? 'org_custom' : null;
    return { kind, key };
  }
  if (['member', 'organization', 'booking'].includes(source)) {
    if (['organisation_dropdown', 'organization_dropdown'].includes(field.type)) return { kind: 'relationship', key: 'organization_id' };
    if (field.type === 'organisation_group_dropdown') return { kind: 'relationship', key: 'organization_group_id' };
  }
  return null;
}

export function buildSurveyInvitationPrefill(fields, booking, settings = {}, enrichment = null) {
  const values = {};
  const unavailable = [];
  const source = settings?.invitation_prefill_config?.source;
  for (const field of fields || []) {
    if (!field?.id || ['__proto__', 'constructor', 'prototype'].includes(field.id)) continue;
    if (field.relationship_config || field.type === 'relationship_dropdown') {
      const value = enrichment?.graph?.values?.[field.id];
      if (value !== undefined) values[field.id] = value;
      else unavailable.push({ field_id: field.id, reason: enrichment?.graph?.reasons?.[field.id] || 'attendee_link_unavailable' });
      continue;
    }
    const mapping = field.prefill_field;
    const parsed = invitationMapping(field, settings);
    if (enrichment && parsed && parsed.kind !== 'booking') {
      let value;
      if (parsed.kind === 'member' && INVITATION_MEMBER_FIELDS.has(parsed.key)) value = enrichment.member?.[parsed.key];
      if (parsed.kind === 'org' && INVITATION_ORG_FIELDS.has(parsed.key)) value = enrichment.organization?.[parsed.key];
      if (parsed.kind === 'member_custom') value = enrichment.memberCustom?.[parsed.key];
      if (parsed.kind === 'org_custom') value = enrichment.organizationCustom?.[parsed.key];
      if (parsed.kind === 'relationship') value = enrichment.relationships?.[parsed.key];
      if (['list', 'countries', 'custom_field'].includes(field.type) && typeof value === 'string' && value.trim().startsWith('[')) {
        try { const parsedValue = JSON.parse(value); if (Array.isArray(parsedValue)) value = parsedValue; } catch { /* scalar retained */ }
      }
      if (value !== undefined && value !== null && value !== ''
        && (typeof value !== 'object' || Array.isArray(value) && value.every(item => ['string', 'boolean', 'number'].includes(typeof item)))) {
        values[field.id] = value;
      } else unavailable.push({ field_id: field.id, reason: 'attendee_value_unavailable' });
      continue;
    }
    let key;
    let fullName = false;
    let reason;
    if (typeof mapping === 'string' && mapping) {
      if (mapping.startsWith('booking:')) key = mapping.slice(8);
      else if (mapping.startsWith('member:')) {
        key = ATTENDEE_ALIASES[mapping.slice(7)];
        if (mapping === 'member:full_name') fullName = true;
        if (!key && !fullName) reason = 'attendee_link_unavailable';
      } else if (!mapping.includes(':') && source === 'booking') key = mapping;
      else if (!mapping.includes(':') && source === 'member') {
        key = ATTENDEE_ALIASES[mapping];
        if (mapping === 'full_name') fullName = true;
        if (!key && !fullName) reason = 'attendee_link_unavailable';
      } else reason = mapping.includes(':') ? 'attendee_link_unavailable' : 'published_source_unavailable';
    } else {
      // Exact legacy identity labels only; explicit configured mappings always win.
      const label = String(field.label || '').trim().toLowerCase();
      if (['email', 'user_email'].includes(field.type) || label === 'email') key = 'attendee_email';
      else if (['first_name', 'user_first_name'].includes(field.type) || label === 'first name') key = 'attendee_first_name';
      else if (['last_name', 'user_last_name'].includes(field.type) || label === 'last name') key = 'attendee_last_name';
      else if (field.type === 'user_name' || label === 'full name') fullName = true;
      else if (['organisation_dropdown', 'organization_dropdown', 'organisation_group_dropdown', 'relationship_dropdown'].includes(field.type) || field.relationship_config) {
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