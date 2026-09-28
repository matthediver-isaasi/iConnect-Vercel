import { createHash } from 'node:crypto';
import { resolveEventCpdCertificate } from './eventCpdCertificateRules.js';
import { renderCpdCertificatePdf } from './cpdCertificatePdf.js';

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
// supplied a default. Points come only from the immutable booking ledger.
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

export async function resolveAttendeeCertificate(db, { tenantId, bookingId, bookingSource }) {
  const booking = await one(db, CERTIFICATE_BOOKINGS[bookingSource], tenantId, bookingId);
  if (!booking) throw Object.assign(new Error('Attendee booking not found'), { status: 404 });
  const eventType = bookingSource === 'complex' ? 'complex' : 'simple';
  const event = await one(db, eventType === 'complex' ? 'complex_event' : 'event', tenantId, booking.event_id);
  if (!event) throw Object.assign(new Error('Event not found'), { status: 404 });
  const member = booking.member_id ? await one(db, 'member', tenantId, booking.member_id) : null;
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
  if ((fields || []).some(p => p.placeholder_key === 'cpd.cpd_points')) {
    // Paginate even when a deployment's REST row cap is below 500.
    for (let offset = 0; ; ) {
      const result = await db.from('member_cpd_points_ledger').select('id,member_id,points_value,entry_kind')
        .eq('tenant_id', tenantId).eq('booking_type', CERTIFICATE_BOOKINGS[bookingSource])
        .eq('booking_id', bookingId).eq('event_id', booking.event_id)
        .eq('event_type', eventType === 'simple' ? 'event' : 'complex_event')
        .order('id').range(offset, offset + 499);
      if (result.error) throw result.error;
      if (!result.data?.length) break;
      pointsRows.push(...result.data);
      offset += result.data.length;
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
  const provenance = { ...policy.provenance, booking_id: bookingId, booking_source: bookingSource,
    booking_status: booking.status, member_id: booking.member_id || null,
    template_version: template.version, template_source_sha256: template.source_sha256,
    points_ledger: pointsRows, values, placeholders: real.placeholders };
  const fingerprint = certificateFingerprint({ provenance, recipient, source_path: template.source_path });
  return { ...base, available: true, can_send: validCertificateRecipient(recipient), fingerprint,
    send_reason: validCertificateRecipient(recipient) ? null : 'The attendee booking has no valid email address.',
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