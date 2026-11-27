// Task #1266 — Admin "send reply" to a form submitter.
//
// Composes and sends a free-text reply email to the person who filled in a
// form (often a non-member, so there is no member/CRM record to email them
// through). The email goes out via the standard TENANT send path (sendEmail
// with tenantId) so the tenant footer + verified sending domain/branding are
// applied automatically. This is a tenant->recipient email, so it does NOT set
// systemEmail.
//
// Every sent reply (success OR failure) is recorded in form_submission_email
// so admins can see what was sent and whether it was delivered.
//
// RBAC: mirrors the export-jobs endpoint used by the same /FormSubmissions
// page — requires an authenticated session whose role is not excluded from the
// Form Submissions / Form Management pages.

import { getSession, getSessionMember, getSessionTenantUser } from '../_lib/session.js';
import { sendEmail, quoteSenderHeaders, resolveDefaultSender } from '../_lib/emailService.js';
import { normalizeMemberEmailAddress } from '../../shared/memberEmailRecipients.mjs';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_FIELDS = new Set(['submission_id', 'to', 'subject', 'html', 'cc', 'bcc', 'senderMode']);

function personalSender(actor) {
  const name = [actor.first_name, actor.last_name].filter(Boolean).join(' ')
    .replace(/[\r\n"\\]/g, '').trim();
  if (!name || /^deleted_.+@deleted\.local$/i.test(actor.email || '')) return null;
  try { return { name, email: normalizeMemberEmailAddress(actor.email) }; }
  catch { return null; }
}

export async function handleSubmissionReply(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  const deliver = dependencies.sendEmail || sendEmail;
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!database) return res.status(503).json({ error: 'Database not configured' });

  const session = await (dependencies.getSession || getSession)(req);
  if (!session?.data) return res.status(401).json({ error: 'Not authenticated' });
  // Only explicit team sessions use team authority. A member/masquerade session
  // must not regain a preserved team identity just to choose a sender.
  const isTeam = !session.data.isMasquerading && session.data.tenantUserId
    && (!session.data.userType || session.data.userType === 'tenant_user');
  const sessionMember = isTeam
    ? await (dependencies.getSessionTenantUser || getSessionTenantUser)(req, session)
    : await (dependencies.getSessionMember || getSessionMember)(req, session);
  if (!sessionMember) return res.status(401).json({ error: 'Not authenticated' });

  const tenantId = sessionMember.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if ((session.data.tenantId && session.data.tenantId !== tenantId)
    || (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== tenantId)) {
    return res.status(403).json({ error: 'Tenant context does not match' });
  }

  // Role-based access: same gate the page itself uses.
  const roleId = sessionMember.role_id;
  if (roleId) {
    const { data: role, error: roleError } = await database
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .eq('tenant_id', tenantId)
      .single();
    if (roleError || !role) return res.status(403).json({ error: 'Unable to verify permissions' });
    const excluded = role?.excluded_features || [];
    if (excluded.includes('page_FormSubmissions') || excluded.includes('page_FormManagement')) {
      return res.status(403).json({ error: 'Access denied - insufficient permissions' });
    }
  }

  const input = req.method === 'GET' ? req.query || {} : req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  if (req.method === 'POST' && Object.keys(input).some(key => !ALLOWED_FIELDS.has(key))) {
    return res.status(400).json({ error: 'Unsupported reply field' });
  }
  const { submission_id, to, subject, html, cc, bcc, senderMode = 'default' } = input;
  if (!['default', 'me'].includes(senderMode)) return res.status(400).json({ error: 'Invalid sender option' });

  if (!submission_id) return res.status(400).json({ error: 'submission_id is required' });
  if (req.method === 'POST') {
    if (!to || typeof to !== 'string' || !EMAIL_RE.test(to.trim())) {
      return res.status(400).json({ error: 'A valid recipient email (to) is required' });
    }
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({ error: 'subject is required' });
    }
    if (!html || typeof html !== 'string' || !html.replace(/<[^>]*>/g, '').trim()) {
      return res.status(400).json({ error: 'Email body is required' });
    }
  }

  // Load the submission to derive/verify tenant scope.
  const { data: submission, error: subErr } = await database
    .from('form_submission')
    .select('id, tenant_id')
    .eq('id', submission_id)
    .maybeSingle();

  if (subErr) {
    console.error('[send-submission-reply] submission lookup failed:', subErr);
    return res.status(500).json({ error: 'Failed to load submission' });
  }
  if (!submission) return res.status(404).json({ error: 'Submission not found' });
  if (submission.tenant_id && submission.tenant_id !== tenantId) {
    return res.status(403).json({ error: 'Cross-tenant access denied' });
  }

  const effectiveTenantId = submission.tenant_id || tenantId;
  const sender = personalSender(sessionMember);
  if (req.method === 'GET') {
    const defaultSender = await (dependencies.resolveDefaultSender || resolveDefaultSender)(effectiveTenantId);
    return res.status(200).json({
      defaultSender: { email: defaultSender.email, from: defaultSender.from },
      personalSender: sender,
      personalUnavailableReason: sender ? null : 'Your name and a valid email address are required to send as you.',
    });
  }
  let senderHeaders = {};
  if (senderMode === 'me') {
    if (!sender) return res.status(409).json({
      error: 'Your sender details are unavailable. Select Default sender or refresh before sending.',
      code: 'SENDER_UNAVAILABLE',
    });
    senderHeaders = await (dependencies.quoteSenderHeaders || quoteSenderHeaders)(effectiveTenantId, sender);
  }
  const toEmail = to.trim();
  const ccEmail = cc && typeof cc === 'string' && cc.trim() ? cc.trim() : null;
  const bccEmail = bcc && typeof bcc === 'string' && bcc.trim() ? bcc.trim() : null;

  // Send via the tenant path so the tenant footer/branding is injected.
  // sendEmail never throws — it returns { success, error }.
  const inboxDelivery = await (dependencies.buildInboxDelivery || buildInboxDelivery)({
    tenantId: effectiveTenantId,
    email: toEmail,
    labelKey: 'forms',
  });
  const emailResult = await deliver({
    to: toEmail,
    subject: subject.trim(),
    html,
    cc: ccEmail || undefined,
    bcc: bccEmail || undefined,
    tenantId: effectiveTenantId,
    inboxDelivery,
    ...senderHeaders,
  });

  const deliveryStatus = emailResult?.success ? 'sent' : 'failed';
  const deliveryError = emailResult?.success ? null : (emailResult?.error || 'Unknown error sending email');

  const { data: record, error: insertErr } = await database
    .from('form_submission_email')
    .insert({
      tenant_id: effectiveTenantId,
      submission_id: submission.id,
      to_email: toEmail,
      cc_email: ccEmail,
      bcc_email: bccEmail,
      subject: subject.trim(),
      body_html: html,
      sent_by_email: sessionMember.email || null,
      sent_by_member_id: isTeam ? null : sessionMember.id || null,
      delivery_status: deliveryStatus,
      delivery_error: deliveryError,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[send-submission-reply] failed to record email:', insertErr);
    // The email may well have been sent; surface that to the caller.
    return res.status(500).json({
      error: 'Email processed but could not be recorded',
      delivery_status: deliveryStatus,
      delivery_error: deliveryError,
    });
  }

  if (deliveryStatus === 'failed') {
    return res.status(502).json({
      error: deliveryError,
      delivery_status: deliveryStatus,
      record,
    });
  }

  return res.status(200).json({ success: true, record });
}

export default async function handler(req, res) {
  try { return await handleSubmissionReply(req, res); }
  catch {
    console.error('[send-submission-reply] Unable to process reply request');
    return res.status(503).json({ error: 'Reply service unavailable. Please try again later.' });
  }
}
