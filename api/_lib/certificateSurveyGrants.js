import { createHash, randomBytes } from 'node:crypto';
import { assignmentWindowState } from './surveyAssignment.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const checked = result => {
  if (result.error) throw result.error;
  return result.data;
};
export const certificateSurveyTokenHash = token =>
  createHash('sha256').update(token).digest('hex');

// A grant is a booking/assignment entitlement, not a substitute for the
// assignment's reusable token. The latter is never enough for member-only
// access and is not sufficient to claim this booking's response.
export async function resolveCertificateSurveyGrantState(db, tenantId, assignment, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const credential = checked(await db.from('certificate_survey_credential').select('*')
    .eq('token_hash', certificateSurveyTokenHash(token)).maybeSingle());
  if (!credential || credential.revoked_at
    || Date.parse(credential.expires_at) <= Date.now()) return null;
  const grant = checked(await db.from('certificate_survey_entitlement').select('*')
    .eq('id', credential.entitlement_id).eq('tenant_id', tenantId)
    .eq('assignment_id', assignment.id).maybeSingle());
  if (!grant || grant.revoked_at || Date.parse(grant.expires_at) <= Date.now()) return null;
  const delivery = checked(await db.from(credential.campaign_delivery_id ? 'campaign_survey_delivery' : 'attendee_cpd_certificate_delivery').select('id,status')
    .eq('id', credential.campaign_delivery_id || credential.delivery_id).eq('tenant_id', tenantId)
    .eq('booking_source', grant.booking_source).eq('booking_id', grant.booking_id).maybeSingle());
  if (delivery?.status !== 'accepted') return null;
  const table = grant.booking_source === 'standard' ? 'booking' : 'complex_event_booking';
  const booking = checked(await db.from(table).select('*')
    .eq('id', grant.booking_id).eq('tenant_id', tenantId).maybeSingle());
  if (!booking || booking.status !== 'confirmed'
    || booking.attendee_email?.trim().toLowerCase() !== grant.recipient_email
    || assignment.event_type !== (grant.booking_source === 'standard' ? 'event' : 'complex_event')
    || booking.event_id !== (assignment.event_type === 'event' ? assignment.event_id : assignment.complex_event_id))
    return null;
  if (grant.completed_at) return { status: 'completed', grant, credential, booking };
  if (assignmentWindowState(assignment) !== 'open') return null;
  return { status: 'active', grant, credential, booking };
}

export async function resolveCertificateSurveyGrant(db, tenantId, assignment, token) {
  const state = await resolveCertificateSurveyGrantState(db, tenantId, assignment, token);
  return state?.status === 'active' ? state : null;
}

export async function prepareCertificateSurveyLinks({
  db, tenant, eventType, eventId, bookingSource, bookingId, recipient, preview = true, deliveryId,
  deliveryKind = 'certificate', assignmentId = null,
}) {
  if (!['certificate', 'campaign'].includes(deliveryKind)) throw new Error('Invalid survey delivery provenance');
  if (!tenant?.id || !tenant?.slug || !eventId || !bookingId
    || !['standard', 'complex'].includes(bookingSource)
    || eventType !== (bookingSource === 'standard' ? 'event' : 'complex_event'))
    throw new Error('Certificate survey context is incomplete');
  const email = typeof recipient === 'string' ? recipient.trim().toLowerCase() : '';
  if (!email) throw new Error('Certificate survey recipient is missing');
  if (!preview && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId || '')) {
    throw new Error('A durable certificate delivery claim is required to issue invitations');
  }
  const booking = checked(await db.from(bookingSource === 'standard' ? 'booking' : 'complex_event_booking')
    .select('id,event_id,status,attendee_email').eq('tenant_id', tenant.id).eq('id', bookingId).maybeSingle());
  if (!booking || booking.status !== 'confirmed' || booking.event_id !== eventId
    || booking.attendee_email?.trim().toLowerCase() !== email)
    throw new Error('The confirmed booking no longer belongs to this certificate recipient');
  const assignments = [];
  for (let offset = 0; ; offset += 500) {
    const page = checked(await db.from('event_survey_assignment').select('*')
      .eq('tenant_id', tenant.id).eq(eventType === 'event' ? 'event_id' : 'complex_event_id', eventId)
      .eq('event_type', eventType).eq('status', 'active')
      .order('id').range(offset, offset + 499));
    assignments.push(...(page || []));
    if (!page || page.length < 500) break;
  }
  const eligible = [];
  // These reasons are returned only to the admin email preview, never included
  // in the recipient message or entitlement snapshot.
  const omitted = [];
  for (const assignment of assignments || []) {
    if (assignmentId && assignment.id !== assignmentId) continue;
    const form = checked(await db.from('form').select('id,name,description,form_type,is_active,survey_settings,deactivate_at,deactivate_timezone')
      .eq('id', assignment.form_id).eq('tenant_id', tenant.id).maybeSingle());
    const state = assignmentWindowState(assignment);
    let reason = null;
    if (!form) reason = 'Survey form is unavailable.';
    else if (form.form_type !== 'survey') reason = 'Assigned form is not a survey.';
    else if (state !== 'open') reason = state === 'not_open_yet' ? 'Assignment has not opened.' : 'Assignment has closed.';
    else if (form.is_active !== true) reason = 'Survey form is inactive.';
    else if (!isFormScheduleAvailable(form)) reason = 'Survey form availability window has closed.';
    else if (form.survey_settings?.status !== 'published') reason = 'Survey is not published.';
    else if (!Number.isInteger(Number(form.survey_settings?.current_version))
      || Number(form.survey_settings.current_version) < 1) reason = 'Survey has no published version.';
    if (reason) {
      if (preview) omitted.push({ title: form?.name || 'Unavailable survey', reason });
      continue;
    }
    eligible.push({ assignment, form });
  }
  if (!eligible.length) {
    const message = 'No surveys are currently available for this event.';
    return { html: `<p>${message}</p>`, text: message, grantIds: [], snapshot: [], ...(preview ? { omitted } : {}) };
  }
  // Never derive a bearer URL from request Host/Origin. Fragment credentials
  // are not transmitted in HTTP requests or Referer headers.
  const base = getTenantTrustedBaseUrl(
    { headers: { host: 'survey-link.invalid' } }, tenant,
  );
  const now = Date.now();
  const grantIds = [];
  const rows = [];
  const snapshot = [];
  for (const { assignment, form } of eligible) {
    const expiry = new Date(Math.min(
      now + 90 * 86400000,
      assignment.closes_at ? Date.parse(assignment.closes_at) : Infinity,
    )).toISOString();
    let url = null;
    let completed = false;
    if (preview) {
      const entitlement = checked(await db.from('certificate_survey_entitlement')
        .select('completed_at').eq('tenant_id', tenant.id)
        .eq('booking_source', bookingSource).eq('booking_id', bookingId)
        .eq('assignment_id', assignment.id).maybeSingle());
      completed = Boolean(entitlement?.completed_at);
    }
    if (!preview) {
      // Uniqueness is enforced in SQL. A resend creates another credential for
      // the SAME entitlement; no completed response is reopened or reset.
      let { data: entitlement, error } = await db.from('certificate_survey_entitlement')
        .insert({
          tenant_id: tenant.id, booking_source: bookingSource, booking_id: bookingId,
          assignment_id: assignment.id, recipient_email: email, expires_at: expiry,
        }).select('*').single();
      if (error?.code === '23505') {
        entitlement = checked(await db.from('certificate_survey_entitlement').select('*')
          .eq('tenant_id', tenant.id).eq('booking_source', bookingSource)
          .eq('booking_id', bookingId).eq('assignment_id', assignment.id).maybeSingle());
      } else if (error) throw error;
      if (!entitlement || entitlement.revoked_at || entitlement.recipient_email !== email) {
        throw new Error('Certificate survey entitlement revoked or booking recipient changed');
      }
      completed = Boolean(entitlement.completed_at);
      if (!completed) {
        if (Date.parse(entitlement.expires_at) < Date.parse(expiry)) {
          entitlement = checked(await db.from('certificate_survey_entitlement')
            .update({ expires_at: expiry }).eq('id', entitlement.id)
            .eq('tenant_id', tenant.id).select('*').single());
        }
        const token = randomBytes(32).toString('base64url');
        const credential = checked(await db.from('certificate_survey_credential')
          .insert({ entitlement_id: entitlement.id,
            [deliveryKind === 'campaign' ? 'campaign_delivery_id' : 'delivery_id']: deliveryId,
            token_hash: certificateSurveyTokenHash(token), expires_at: expiry })
          .select('id').single());
        grantIds.push(credential.id);
        url = `${base}/survey/${encodeURIComponent(assignment.token)}#certificate_grant=${token}`;
      }
    }
    rows.push({
      assignmentId: assignment.id,
      assignmentUrl: `${base}/survey/${encodeURIComponent(assignment.token)}`,
      title: form.name, description: form.description || '',
      closes: assignment.closes_at ? new Date(assignment.closes_at).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : '',
      url, completed,
    });
    snapshot.push({
      assignment_id: assignment.id, form_id: form.id,
      assignment_token_sha256: createHash('sha256').update(String(assignment.token || '')).digest('hex'),
      invitation_host: new URL(base).host,
      survey_version: form.survey_settings.current_version,
      opens_at: assignment.opens_at || null, closes_at: assignment.closes_at || null,
      title: form.name, description: form.description || '', completed,
    });
  }
  return {
    grantIds, snapshot, links: rows, ...(preview ? { omitted } : {}),
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:Arial,sans-serif;border-collapse:collapse"><tr><td style="padding:0 0 12px">Surveys for this event:</td></tr>${rows.map(row =>
      `<tr><td style="padding:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #ddd"><tr><td style="padding:16px 16px 8px;font-weight:bold">${safe(row.title)}</td></tr>${row.description ? `<tr><td style="padding:0 16px 8px">${safe(row.description)}</td></tr>` : ''}${row.closes ? `<tr><td style="padding:0 16px 8px">Closing date: ${safe(row.closes)}</td></tr>` : ''}<tr><td style="padding:8px 16px 16px">${row.url ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#1e4774" style="background-color:#1e4774;border-radius:4px;padding:10px 16px"><a href="${safe(row.url)}" style="color:#ffffff;text-decoration:none;display:inline-block">Complete survey</a></td></tr></table>` : (row.completed ? 'Response received' : 'Survey link available in the sent email')}</td></tr></table></td></tr>`).join('')}</table>`,
    text: `Surveys for this event:\n\n${rows.map(row => [
      row.title, row.description, row.closes ? `Closing date: ${row.closes}` : '',
      row.url || (row.completed ? 'Response received' : 'Survey link available in the sent email'),
    ].filter(Boolean).join('\n')).join('\n\n')}`,
  };
}

export async function setCertificateSurveyGrantsDelivery({ db, grantIds, deliveryId, status }) {
  if (!['accepted', 'failed'].includes(status)) throw new Error('Invalid grant delivery status');
  // Accepted status needs NO second write: each credential is joined to its
  // durable delivery_id at both lookup and atomic submission boundaries.
  if (status === 'accepted' || (!deliveryId && !grantIds?.length)) return;
  // Delivery scope also covers partial issuance when preparation throws before
  // it can return the credential IDs. Other deliveries' credentials stay valid.
  const query = db.from('certificate_survey_credential')
    .update({ revoked_at: new Date().toISOString() });
  const { error } = await (deliveryId ? query.eq('delivery_id', deliveryId) : query.in('id', grantIds));
  if (error) throw error;
}

export async function revokeCertificateSurveyEntitlement({ db, tenantId, bookingSource, bookingId, assignmentId }) {
  const { error } = await db.from('certificate_survey_entitlement')
    .update({ revoked_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('booking_source', bookingSource)
    .eq('booking_id', bookingId).eq('assignment_id', assignmentId);
  if (error) throw error;
}