import crypto from 'crypto';
import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { sendEmail, replacePlaceholders } from '../../_lib/emailService.js';

function applyBriefPlaceholders(input, vars) {
  if (typeof input !== 'string' || !input) return input || '';
  let out = input;
  for (const [key, value] of Object.entries(vars)) {
    const safe = value == null ? '' : String(value);
    const re = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
    out = out.replace(re, safe);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { briefId } = req.query;

    if (!briefId) {
      return res.status(400).json({ error: 'briefId is required' });
    }

    const { form_id, provider, email_content, email_template_id } = req.body;

    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }
    if (!provider?.email || !provider?.first_name || !provider?.last_name) {
      return res.status(400).json({ error: 'Provider first_name, last_name, and email are required' });
    }
    // When a template is selected the template body is the message and free
    // text is optional. Otherwise the legacy free-text editor is the source
    // of truth and must be filled in.
    if (!email_template_id && !email_content) {
      return res.status(400).json({ error: 'email_content is required' });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, title, tenant_id')
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (briefError || !brief) {
      return res.status(404).json({ error: 'Article brief not found' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, slug, is_active, require_authentication')
      .eq('id', form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (formError || !form) {
      return res.status(400).json({ error: 'Permission form not found' });
    }
    if (!form.is_active) {
      return res.status(400).json({ error: 'Permission form is not active' });
    }
    if (form.require_authentication) {
      return res.status(400).json({ error: 'Permission form requires authentication and cannot be used for external case study providers' });
    }
    if (!form.slug) {
      return res.status(400).json({ error: 'Permission form does not have a slug configured' });
    }

    // Optional email template lookup (tenant scoped, must be active)
    let template = null;
    if (email_template_id) {
      const { data: tpl, error: tplError } = await supabase
        .from('email_template')
        .select('id, name, subject, body, from_email, reply_to, is_active')
        .eq('id', email_template_id)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      if (tplError || !tpl) {
        return res.status(400).json({ error: 'Selected email template not found' });
      }
      if (!tpl.is_active) {
        return res.status(400).json({ error: 'Selected email template is not active' });
      }
      template = tpl;
    }

    const { data: tenantRecord } = await supabase
      .from('tenant')
      .select('domain, slug')
      .eq('id', tenantCtx.tenantId)
      .single();

    const tenantHost = tenantRecord?.domain || `${tenantRecord?.slug || 'app'}.iconn.app`;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${protocol}://${tenantHost}`;

    const permissionUrl = `${baseUrl}/FormView?slug=${encodeURIComponent(form.slug)}&brief_id=${encodeURIComponent(briefId)}`;

    const uploadToken = crypto.randomBytes(32).toString('hex');
    const uploadUrl = `${baseUrl}/CaseStudyUpload?token=${encodeURIComponent(uploadToken)}`;

    const placeholderVars = {
      'brief.title': brief.title || '',
      'provider.first_name': provider.first_name || '',
      'provider.last_name': provider.last_name || '',
      'provider.email': provider.email || '',
      'provider.full_name': [provider.first_name, provider.last_name].filter(Boolean).join(' ').trim(),
      'form_url': permissionUrl,
      'upload_url': uploadUrl,
    };

    const renderButton = (url, label) => `
      <div style="margin-top: 16px;">
        <a href="${url}"
           style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 500;">
          ${label}
        </a>
      </div>
      <p style="color: #888; font-size: 13px; margin-top: 8px;">
        Or copy this link: <a href="${url}" style="color: #2563eb;">${url}</a>
      </p>
    `;

    let bodyHtml = template
      ? applyBriefPlaceholders(template.body || '', placeholderVars)
      : email_content;

    // Providers are always external (no member row). Run the generic helper
    // first (resolves any preference link tokens via context), THEN strip
    // any remaining [[member.*]] / [[organization.*]] tokens so they do not
    // leak as literal placeholders. (`replacePlaceholders` returns the
    // original match when a value is missing, so an explicit strip pass is
    // required for the no-member-context case.)
    bodyHtml = replacePlaceholders(bodyHtml, 'record', {}, { tenantId: tenantCtx.tenantId });
    bodyHtml = bodyHtml
      .replace(/\[\[(?:member|organization)\.\w+\]\]/gi, '')
      .replace(/\{\{(?:member|organization)\.\w+\}\}/gi, '');

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="color: #333; font-size: 15px; line-height: 1.6;">
          ${bodyHtml}
        </div>
        ${renderButton(permissionUrl, 'Complete the Permission Form')}
        ${renderButton(uploadUrl, 'Upload Images & Documents')}
      </div>
    `;

    let subject = template?.subject
      ? applyBriefPlaceholders(template.subject, placeholderVars)
      : `Case Study Form: ${brief.title || 'Article Brief'}`;
    subject = replacePlaceholders(subject, 'record', {}, { tenantId: tenantCtx.tenantId });
    subject = subject
      .replace(/\[\[(?:member|organization)\.\w+\]\]/gi, '')
      .replace(/\{\{(?:member|organization)\.\w+\}\}/gi, '');

    const emailResult = await sendEmail({
      to: provider.email,
      subject,
      html: emailHtml,
      from: template?.from_email || undefined,
      replyTo: template?.reply_to || undefined,
      tenantId: tenantCtx.tenantId,
      skipFooter: false,
    });

    if (!emailResult || emailResult.success !== true) {
      console.error('[SendCaseStudyForm] Email send failed:', emailResult?.error || 'Unknown error');
      return res.status(500).json({ error: 'Failed to send email: ' + (emailResult?.error || 'Unknown error') });
    }

    const now = new Date().toISOString();
    const updatePayload = {
      case_study_form_id: form_id,
      case_study_provider: {
        first_name: provider.first_name,
        last_name: provider.last_name,
        email: provider.email,
      },
      case_study_email_content: email_content || null,
      case_study_email_template_id: email_template_id || null,
      case_study_form_sent_at: now,
      case_study_submission_id: null,
      case_study_upload_token: uploadToken,
      case_study_upload_token_created_at: now,
    };

    const { error: updateError } = await supabase
      .from('article_brief')
      .update(updatePayload)
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[SendCaseStudyForm] Failed to update brief:', updateError);
      return res.status(500).json({ error: 'Email sent but failed to update brief record' });
    }

    console.log(`[SendCaseStudyForm] Permission form link sent to ${provider.email} for brief ${briefId}`);

    return res.status(200).json({
      success: true,
      message: 'Case study form link sent successfully',
      sent_at: now,
    });
  } catch (error) {
    console.error('[SendCaseStudyForm] Error:', error);
    return res.status(500).json({ error: 'Failed to send case study form: ' + (error.message || 'Unknown error') });
  }
}
