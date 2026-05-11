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

    const { copyright_form_id, email_template_id } = req.body || {};
    if (!copyright_form_id) {
      return res.status(400).json({ error: 'copyright_form_id is required' });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, title, tenant_id, assigned_writer_id, external_writer_id, copyright_form_id, copyright_submission_id')
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (briefError || !brief) {
      return res.status(404).json({ error: 'Article brief not found' });
    }

    // Resolve writer name + email from assigned member or external writer
    let writerEmail = null;
    let writerFirstName = null;
    let writerLastName = null;

    if (brief.external_writer_id) {
      const { data: ext } = await supabase
        .from('external_writer')
        .select('first_name, last_name, email')
        .eq('id', brief.external_writer_id)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      if (ext) {
        writerEmail = ext.email || null;
        writerFirstName = ext.first_name || null;
        writerLastName = ext.last_name || null;
      }
    } else if (brief.assigned_writer_id) {
      const { data: mem } = await supabase
        .from('member')
        .select('first_name, last_name, email')
        .eq('id', brief.assigned_writer_id)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      if (mem) {
        writerEmail = mem.email || null;
        writerFirstName = mem.first_name || null;
        writerLastName = mem.last_name || null;
      }
    } else {
      return res.status(400).json({ error: 'No writer is assigned to this brief' });
    }

    if (!writerEmail) {
      return res.status(400).json({ error: 'The assigned writer has no email address on file' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, slug, is_active, require_authentication')
      .eq('id', copyright_form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (formError || !form) {
      return res.status(400).json({ error: 'Copyright Assignment form not found' });
    }
    if (!form.is_active) {
      return res.status(400).json({ error: 'Copyright Assignment form is not active' });
    }
    if (form.require_authentication) {
      return res.status(400).json({ error: 'Copyright Assignment form requires authentication and cannot be used for the writer link' });
    }
    if (!form.slug) {
      return res.status(400).json({ error: 'Copyright Assignment form does not have a slug configured' });
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

    const formUrl = `${baseUrl}/FormView?slug=${encodeURIComponent(form.slug)}&brief_id=${encodeURIComponent(briefId)}`;

    const writerName = [writerFirstName, writerLastName].filter(Boolean).join(' ').trim() || 'there';

    const placeholderVars = {
      'brief.title': brief.title || '',
      'writer.first_name': writerFirstName || '',
      'writer.last_name': writerLastName || '',
      'writer.full_name': writerName,
      'writer.email': writerEmail || '',
      'form_url': formUrl,
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

    const defaultBody = `
        <div style="color: #333; font-size: 15px; line-height: 1.6;">
          <p>Hi ${writerName},</p>
          <p>Please complete the Copyright Assignment Form for the article brief
            "<strong>${brief.title || 'Article Brief'}</strong>".</p>
        </div>
    `;

    let templateBodyRendered = template ? applyBriefPlaceholders(template.body || '', placeholderVars) : '';

    // When the writer is an internal member, also run the template through
    // the generic [[member.*]] / [[organization.*]] resolver so those tokens
    // do not leak as literals. External-writer path skips this — there is no
    // member context to resolve.
    if (template && brief.assigned_writer_id && !brief.external_writer_id) {
      const memberRow = {
        id: brief.assigned_writer_id,
        first_name: writerFirstName || '',
        last_name: writerLastName || '',
        email: writerEmail || '',
      };
      templateBodyRendered = replacePlaceholders(templateBodyRendered, 'member', memberRow, { tenantId: tenantCtx.tenantId, memberId: brief.assigned_writer_id });
    }

    const bodyHtml = template
      ? `<div style="color: #333; font-size: 15px; line-height: 1.6;">${templateBodyRendered}</div>`
      : defaultBody;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${bodyHtml}
        ${renderButton(formUrl, 'Complete the Copyright Assignment Form')}
      </div>
    `;

    let subject = template?.subject
      ? applyBriefPlaceholders(template.subject, placeholderVars)
      : `Copyright Assignment Form: ${brief.title || 'Article Brief'}`;

    if (template && brief.assigned_writer_id && !brief.external_writer_id) {
      subject = replacePlaceholders(subject, 'member', {
        id: brief.assigned_writer_id,
        first_name: writerFirstName || '',
        last_name: writerLastName || '',
        email: writerEmail || '',
      }, { tenantId: tenantCtx.tenantId, memberId: brief.assigned_writer_id });
    }

    const emailResult = await sendEmail({
      to: writerEmail,
      subject,
      html: emailHtml,
      from: template?.from_email || undefined,
      replyTo: template?.reply_to || undefined,
      tenantId: tenantCtx.tenantId,
      skipFooter: false,
    });

    if (!emailResult || emailResult.success !== true) {
      console.error('[SendCopyrightForm] Email send failed:', emailResult?.error || 'Unknown error');
      return res.status(500).json({ error: 'Failed to send email: ' + (emailResult?.error || 'Unknown error') });
    }

    const now = new Date().toISOString();
    // Only clear an existing received submission when the editor is switching
    // to a *different* copyright form than the one the existing submission was
    // actually made against — in that case a new submission really is
    // expected. If the editor re-sends the same form, preserve the previously
    // received submission so a stray "Send" click does not silently wipe
    // evidence. We check the linked submission's own form_id as the source of
    // truth (rather than just brief.copyright_form_id, which may have been
    // changed in flight) so the comparison stays correct even if the brief's
    // selected form was edited after the submission was received.
    const briefUpdate = {
      copyright_required: true,
      copyright_form_id,
      copyright_email_template_id: email_template_id || null,
      copyright_form_sent_at: now,
    };

    if (brief.copyright_submission_id) {
      let existingSubmissionFormId = null;
      const { data: existingSubmission, error: existingSubError } = await supabase
        .from('form_submission')
        .select('id, form_id')
        .eq('id', brief.copyright_submission_id)
        .maybeSingle();
      if (existingSubError) {
        console.error('[SendCopyrightForm] Failed to load existing submission:', existingSubError);
      } else if (existingSubmission) {
        existingSubmissionFormId = existingSubmission.form_id;
      }

      // Conservative compare: if we cannot read the existing submission's
      // form_id, fall back to comparing against brief.copyright_form_id so we
      // still preserve the link on a same-form re-send rather than wiping it.
      const linkedFormId = existingSubmissionFormId || brief.copyright_form_id;
      const isSwitchingForm = linkedFormId && linkedFormId !== copyright_form_id;
      if (isSwitchingForm) {
        briefUpdate.copyright_submission_id = null;
      }
    }

    const { error: updateError } = await supabase
      .from('article_brief')
      .update(briefUpdate)
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[SendCopyrightForm] Failed to update brief:', updateError);
      return res.status(500).json({ error: 'Email sent but failed to update brief record' });
    }

    console.log(`[SendCopyrightForm] Copyright form link sent to ${writerEmail} for brief ${briefId}`);

    return res.status(200).json({
      success: true,
      message: 'Copyright Assignment form link sent to writer',
      sent_at: now,
      writer_email: writerEmail,
    });
  } catch (error) {
    console.error('[SendCopyrightForm] Error:', error);
    return res.status(500).json({ error: 'Failed to send copyright form: ' + (error.message || 'Unknown error') });
  }
}
