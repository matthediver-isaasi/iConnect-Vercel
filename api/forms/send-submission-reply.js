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

import { getSessionMember } from '../_lib/session.js';
import { sendEmail } from '../_lib/emailService.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) return res.status(401).json({ error: 'Not authenticated' });

  const tenantId = sessionMember.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

  // Role-based access: same gate the page itself uses.
  const roleId = sessionMember.role_id;
  if (roleId) {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    const excluded = role?.excluded_features || [];
    if (excluded.includes('page_FormSubmissions') || excluded.includes('page_FormManagement')) {
      return res.status(403).json({ error: 'Access denied - insufficient permissions' });
    }
  }

  const { submission_id, to, subject, html, cc, bcc } = req.body || {};

  if (!submission_id) return res.status(400).json({ error: 'submission_id is required' });
  if (!to || typeof to !== 'string' || !EMAIL_RE.test(to.trim())) {
    return res.status(400).json({ error: 'A valid recipient email (to) is required' });
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'subject is required' });
  }
  if (!html || typeof html !== 'string' || !html.replace(/<[^>]*>/g, '').trim()) {
    return res.status(400).json({ error: 'Email body is required' });
  }

  // Load the submission to derive/verify tenant scope.
  const { data: submission, error: subErr } = await supabase
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
  const toEmail = to.trim();
  const ccEmail = cc && typeof cc === 'string' && cc.trim() ? cc.trim() : null;
  const bccEmail = bcc && typeof bcc === 'string' && bcc.trim() ? bcc.trim() : null;

  // Send via the tenant path so the tenant footer/branding is injected.
  // sendEmail never throws — it returns { success, error }.
  const inboxDelivery = await buildInboxDelivery({
    tenantId: effectiveTenantId,
    email: toEmail,
    labelKey: 'forms',
  });
  const emailResult = await sendEmail({
    to: toEmail,
    subject: subject.trim(),
    html,
    cc: ccEmail || undefined,
    bcc: bccEmail || undefined,
    tenantId: effectiveTenantId,
    inboxDelivery,
  });

  const deliveryStatus = emailResult?.success ? 'sent' : 'failed';
  const deliveryError = emailResult?.success ? null : (emailResult?.error || 'Unknown error sending email');

  const { data: record, error: insertErr } = await supabase
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
      sent_by_member_id: sessionMember.id || null,
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
