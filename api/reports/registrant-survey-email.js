import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { loadRegistrantSurveyEvent, resolveRegistrantSurveyEmail } from '../_lib/registrantSurveyEmail.js';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
export async function handleRegistrantSurveyEmail(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const db = deps.db || supabase;
  try {
    const ctx = await (deps.contextFor || getTenantContext)(req);
    if (!ctx?.tenantId || !ctx.isAuthenticated) return res.status(401).json({ error: 'Sign in required.' });
    if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
    if (!(await (deps.adminAccess || hasAdminAccess)(ctx))
      || (ctx.roleId && !(await (deps.featureAccess || hasFeatureAccess)(ctx.roleId, 'events.event-report', ctx.memberExcludedFeatures)))) {
      return res.status(403).json({ error: 'Event Registration Report access required.' });
    }
    const input = (req.method === 'GET' ? req.query : req.body) || {};
    if (!['standard', 'complex'].includes(input.booking_source)) return res.status(400).json({ error: 'Invalid booking source.' });
    if (req.method === 'GET') {
      if (!uuid(input.event_id)) return res.status(400).json({ error: 'Invalid event.' });
      const context = await (deps.loadEvent || loadRegistrantSurveyEvent)(db, ctx.tenantId, input.event_id, input.booking_source);
      return res.status(200).json({ tracking: context.tracking, surveys: context.surveys.map(({ token, ...survey }) => survey) });
    }
    if (!uuid(input.booking_id) || !uuid(input.assignment_id) || !['preview', 'send'].includes(input.action)) {
      return res.status(400).json({ error: 'Select a registration and survey.' });
    }
    const message = await (deps.resolve || resolveRegistrantSurveyEmail)(db, ctx.tenantId, input);
    if (input.action === 'preview') return res.status(200).json(message);
    if (input.confirmed !== true || message.fingerprint !== input.expected_fingerprint
      || (message.attendance_warning && input.acknowledge_unverified !== true)) {
      return res.status(409).json({ error: 'Review the current email and confirm attendance before sending.' });
    }
    if (!uuid(input.request_id)) return res.status(400).json({ error: 'A send request identifier is required.' });
    const actor = ctx.memberId || ctx.tenantUserId;
    if (!actor) return res.status(403).json({ error: 'Administrator identity required.' });
    const { data: existing, error: existingError } = await db.from('registrant_survey_delivery')
      .select('status,booking_source,booking_id,assignment_id').eq('tenant_id', ctx.tenantId).eq('id', input.request_id).maybeSingle();
    if (existingError) throw new Error('Survey email delivery storage is unavailable.');
    if (existing) {
      if (existing.booking_id !== input.booking_id || existing.assignment_id !== input.assignment_id || existing.booking_source !== input.booking_source) {
        return res.status(409).json({ error: 'This send request belongs to a different registration.' });
      }
      return res.status(existing.status === 'accepted' ? 200 : 409).json(existing.status === 'accepted'
        ? { sent: true, already_sent: true } : { error: 'This send has already been attempted. Review its delivery status before retrying.' });
    }
    const { error: insertError } = await db.from('registrant_survey_delivery').insert({
      id: input.request_id, tenant_id: ctx.tenantId, booking_source: input.booking_source, booking_id: input.booking_id,
      assignment_id: input.assignment_id, recipient: message.recipient, actor: String(actor), fingerprint: message.fingerprint,
    });
    if (insertError) return res.status(409).json({ error: insertError.code === '23505'
      ? 'A send for this registrant and survey is already pending. Do not resend until its outcome is confirmed.'
      : 'Survey email could not be recorded. No email was sent.' });
    // Never automatically replay an uncertain provider outcome.
    let result;
    try {
      result = await (deps.send || sendEmail)({
        tenantId: ctx.tenantId, to: message.recipient, subject: message.subject,
        html: message.html, text: message.text, skipFooter: true, disableTracking: true,
      });
    } catch { result = { success: false }; }
    const status = result?.success ? 'accepted' : result?.notSubmitted ? 'failed' : 'unknown';
    const { data: finalized, error: finalError } = await db.from('registrant_survey_delivery').update({
      status, provider_message_id: result?.messageId || result?.id || null, updated_at: new Date().toISOString(),
    }).eq('tenant_id', ctx.tenantId).eq('id', input.request_id).eq('status', 'pending').select('id').maybeSingle();
    if (finalError || !finalized || status !== 'accepted') return res.status(503).json({
      error: 'Delivery could not be confirmed. Do not send again until an administrator has checked the delivery record.',
    });
    return res.status(200).json({ sent: true });
  } catch (error) {
    return res.status(409).json({ error: error.message || 'Survey invitation could not be prepared.' });
  }
}
export default handleRegistrantSurveyEmail;
