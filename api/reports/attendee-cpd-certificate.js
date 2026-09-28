import { supabase } from '../_lib/database.js';
import { createHash } from 'node:crypto';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { CERTIFICATE_BOOKINGS, resolveAttendeeCertificate, renderAttendeeCertificate } from '../_lib/attendeeCpdCertificate.js';
import { prepareCpdEmail } from '../_lib/eventCpdEmail.js';
import { prepareCertificateSurveyLinks, setCertificateSurveyGrantsDelivery } from '../_lib/certificateSurveyGrants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const redactCredential = value => typeof value === 'string'
  ? value.replace(new RegExp('certificate_grant(?:=|%3D|&#61;)[A-Za-z0-9_-]+', 'gi'),
    'certificate_grant=[redacted]')
  : value;
export const publicDelivery = row => row ? {
  id: row.id, status: row.status, recipient: row.recipient, created_at: row.created_at,
  updated_at: row.updated_at, error: row.error || null, provider_message_id: row.provider_message_id || null,
} : null;

async function latestDelivery(db, tenantId, source, id) {
  const { data, error } = await db.from('attendee_cpd_certificate_delivery')
    .select('id,status,recipient,created_at,updated_at,error,provider_message_id')
    .eq('tenant_id', tenantId).eq('booking_source', source).eq('booking_id', id)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function handleAttendeeCertificate(req, res, deps = {}) {
  const db = deps.db || supabase;
  const resolve = deps.resolve || resolveAttendeeCertificate;
  const render = deps.render || renderAttendeeCertificate;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const context = await (deps.contextFor || getTenantContext)(req);
    if (!context?.tenantId || !context.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
    if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
    if (!(await (deps.adminAccess || hasAdminAccess)(context))
      || (context.roleId && !(await (deps.featureAccess || hasFeatureAccess)(context.roleId, 'events.event-report', context.memberExcludedFeatures)))) {
      return res.status(403).json({ error: 'You do not have access to the Event Registration Report' });
    }
    const input = req.method === 'GET' ? req.query : req.body;
    const { booking_id: bookingId, booking_source: bookingSource } = input || {};
    if (!UUID.test(bookingId || '') || !Object.hasOwn(CERTIFICATE_BOOKINGS, bookingSource || '')) {
      return res.status(400).json({ error: 'A valid booking_id and booking_source (standard or complex) are required' });
    }
    const identity = { tenantId: context.tenantId, bookingId, bookingSource };
    if (req.method === 'POST' && !['preview', 'email-preview', 'send'].includes(input.action)) {
      return res.status(400).json({ error: 'action must be preview, email-preview or send' });
    }
    const resolved = await resolve(db, identity);
    const latest = await latestDelivery(db, context.tenantId, bookingSource, bookingId);
    const blocked = latest && ['pending', 'unknown'].includes(latest.status);
    const metadata = {
      attendee_name: resolved.attendee_name, recipient: resolved.recipient, event_name: resolved.event_name,
      available: resolved.available, reason: resolved.reason, fingerprint: resolved.fingerprint,
      template_name: resolved.template_name || null,
      certificate_points: resolved.certificate_points ?? null,
      certificate_points_source: resolved.certificate_points_source || null,
      email_template_id: resolved.email_template_id || null,
      email_template_name: resolved.email_template_name || null,
      email_is_default: resolved.email_is_default,
      email_selection_missing: resolved.email_selection_missing === true,
      email_reason: resolved.email_reason || null,
      can_send: resolved.can_send && !blocked,
      send_reason: blocked ? 'A previous send is pending or its provider outcome is unknown. Reconcile it before sending again.' : resolved.send_reason || resolved.reason,
      latest_delivery: publicDelivery(latest),
    };
    if (req.method === 'GET') return res.status(200).json(metadata);
    if (!resolved.available) return res.status(409).json({ error: resolved.reason, ...metadata });
    if (!input.expected_fingerprint || input.expected_fingerprint !== resolved.fingerprint) {
      return res.status(409).json({ error: 'Certificate data or recipient changed. Reload and preview before confirming.', ...metadata });
    }
    if (input.action === 'preview') {
      const pdf = await render(db, resolved);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="cpd-certificate.pdf"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(pdf);
    }
    if (input.action === 'email-preview') {
      if (!resolved.can_send) return res.status(409).json({ error: resolved.send_reason });
      const pdf = await render(db, resolved);
      return res.status(200).json({
        subject: resolved.email_message.subject, html: resolved.email_message.html,
        text: resolved.email_message.text || null,
        attachment: { filename: 'cpd-certificate.pdf', content_type: 'application/pdf',
          bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex') },
        survey_links_inactive: true,
      });
    }
    if (input.confirmed !== true || !UUID.test(input.request_id || '')) {
      return res.status(400).json({ error: 'Explicit confirmation and a UUID request_id are required' });
    }
    if (!resolved.can_send) return res.status(409).json({ error: resolved.send_reason });
    const { data: claim, error: claimError } = await db.rpc('claim_attendee_cpd_certificate_delivery', {
      p_tenant_id: context.tenantId, p_booking_source: bookingSource, p_booking_id: bookingId,
      p_request_id: input.request_id, p_fingerprint: resolved.fingerprint,
      p_actor: context.memberId ? `member:${context.memberId}` : `tenant_user:${context.tenantUserId}`,
      p_recipient: resolved.recipient, p_provenance: resolved.provenance,
      p_deliberate_resend: input.deliberate_resend === true,
    });
    if (claimError) throw claimError;
    if (!claim.claimed) {
      const delivery = publicDelivery(claim.delivery);
      return res.status(claim.reason === 'retry' ? 200 : 409).json({
        success: delivery?.status === 'accepted', duplicate: claim.reason === 'retry',
        latest_delivery: delivery,
        error: claim.reason === 'retry' ? null : claim.reason === 'resend_required'
          ? 'This attendee has already had a certificate accepted by the email provider. Confirm a deliberate resend.'
          : 'A send is pending, unknown, or conflicts with this request. Do not retry blindly.',
      });
    }
    let outcome;
    let attempted = false;
    let surveyGrantIds = [];
    try {
      const pdf = await render(db, resolved);
      // Recheck just before the provider boundary: cancellation, changed email,
      // template/configuration changes, guest evidence and ledger corrections invalidate consent.
      const current = await resolve(db, identity);
      if (!current.available || !current.can_send || current.fingerprint !== resolved.fingerprint) {
        throw new Error('Certificate data changed during preparation. Reload before confirming again.');
      }
      let emailMessage = current.email_message;
      if (current.survey_list_enabled) {
        const { data: tenant, error: tenantError } = await db.from('tenant')
          .select('id,slug,domain').eq('id', context.tenantId).maybeSingle();
        if (tenantError || !tenant) throw tenantError || new Error('Certificate tenant unavailable');
        const prepareList = deps.prepareSurveyLinks || prepareCertificateSurveyLinks;
        const surveyList = await prepareList({
          db, tenant, eventType: bookingSource === 'standard' ? 'event' : 'complex_event',
          eventId: current.event_id, bookingSource, bookingId,
          recipient: current.recipient, preview: false, deliveryId: claim.delivery.id,
        });
        surveyGrantIds = surveyList.grantIds;
        if (JSON.stringify(surveyList.snapshot) !== JSON.stringify(current.survey_list?.snapshot)) {
          throw new Error('Certificate survey availability changed during preparation. Reload and preview again.');
        }
        const preparedEmail = await prepareCpdEmail(db, context.tenantId,
          current.email_selection, current.email_values, surveyList);
        if (preparedEmail.reason) throw new Error(preparedEmail.reason);
        emailMessage = preparedEmail.message;
      }
      attempted = true;
      const result = await (deps.send || sendEmail)({
        tenantId: context.tenantId, to: resolved.recipient,
        ...emailMessage,
        enableTracking: false,
        disableTracking: true,
        includeRenderedContent: true,
        attachments: [{ filename: 'cpd-certificate.pdf', data: pdf, contentType: 'application/pdf' }],
      });
      outcome = result.success ? { status: 'accepted', provider_message_id: result.id || result.messageId || null, error: null }
        : { status: result.ambiguousEffect || !result.status || Number(result.status) >= 500 ? 'unknown' : 'failed',
          error: redactCredential(result.error) || 'Email provider did not confirm acceptance', provider_message_id: null };
      if (result.success) {
        // The transport resolves footer/preference tokens at the final-recipient
        // boundary. Retain that final envelope as well as the confirmed template.
        // Initial claim provenance is immutable. The separately granted column
        // records transport output without rewriting the confirmed snapshot.
        outcome.rendered_email = {
          subject: redactCredential(result.renderedSubject ?? emailMessage.subject),
          html: redactCredential(result.renderedHtml ?? emailMessage.html),
          text: redactCredential(result.renderedText ?? emailMessage.text ?? null),
          from: result.fromAddress || emailMessage.from || null,
          domain: result.domain || null,
        };
      }
    } catch (error) {
      outcome = { status: attempted ? 'unknown' : 'failed',
        error: redactCredential(error.message) || 'Certificate preparation failed', provider_message_id: null };
    }
    const { data: finished, error: finishError } = await db.from('attendee_cpd_certificate_delivery')
      .update({ ...outcome, updated_at: new Date().toISOString() })
      .eq('tenant_id', context.tenantId).eq('id', claim.delivery.id).eq('status', 'pending')
      .select('id,status,recipient,created_at,updated_at,error,provider_message_id').single();
    // A durable pending row remains a permanent replay fence if persistence fails
    // after Mailgun accepts. There is intentionally no timed automatic reclaim.
    if (finishError) return res.status(503).json({ error: 'The send outcome could not be recorded. Do not resend; reconcile the pending delivery first.' });
    if (surveyGrantIds.length && outcome.status === 'failed') {
      try {
        await (deps.setSurveyGrantDelivery || setCertificateSurveyGrantsDelivery)({
          db, grantIds: surveyGrantIds, status: outcome.status,
        });
      } catch {
        return res.status(503).json({
          error: 'The failed delivery was recorded but survey invitations could not be revoked. Do not resend; reconcile the delivery first.',
          latest_delivery: publicDelivery(finished),
        });
      }
    }
    return res.status(outcome.status === 'accepted' ? 200 : 502).json({
      success: outcome.status === 'accepted', latest_delivery: publicDelivery(finished),
      message: outcome.status === 'accepted' ? 'Accepted by the email provider; inbox delivery is not confirmed.' : undefined,
      error: outcome.error || undefined,
    });
  } catch (error) {
    // Provider and transport exceptions may embed the message body and bearer
    // invitation; never log exception text or stack on this route.
    console.error('[attendee-cpd-certificate] Certificate request failed');
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to prepare the certificate. Check certificate configuration and delivery audit availability.' });
  }
}

export default function handler(req, res) {
  return handleAttendeeCertificate(req, res);
}