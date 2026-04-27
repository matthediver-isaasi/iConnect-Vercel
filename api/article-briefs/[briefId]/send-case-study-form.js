import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { sendEmail } from '../../_lib/emailService.js';

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

    const { form_id, copyright_form_id, provider, email_content } = req.body;

    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }
    if (!provider?.email || !provider?.first_name || !provider?.last_name) {
      return res.status(400).json({ error: 'Provider first_name, last_name, and email are required' });
    }
    if (!email_content) {
      return res.status(400).json({ error: 'email_content is required' });
    }
    if (copyright_form_id && copyright_form_id === form_id) {
      return res.status(400).json({ error: 'Permission and Copyright Assignment forms must be different' });
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

    const loadAndValidateForm = async (formId, label) => {
      const { data: form, error: formError } = await supabase
        .from('form')
        .select('id, name, slug, is_active, require_authentication')
        .eq('id', formId)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();

      if (formError || !form) {
        return { error: `${label} form not found` };
      }
      if (!form.is_active) {
        return { error: `${label} form is not active` };
      }
      if (form.require_authentication) {
        return { error: `${label} form requires authentication and cannot be used for external case study providers` };
      }
      if (!form.slug) {
        return { error: `${label} form does not have a slug configured` };
      }
      return { form };
    };

    const permissionResult = await loadAndValidateForm(form_id, 'Permission');
    if (permissionResult.error) {
      return res.status(400).json({ error: permissionResult.error });
    }
    const permissionForm = permissionResult.form;

    let copyrightForm = null;
    if (copyright_form_id) {
      const copyrightResult = await loadAndValidateForm(copyright_form_id, 'Copyright Assignment');
      if (copyrightResult.error) {
        return res.status(400).json({ error: copyrightResult.error });
      }
      copyrightForm = copyrightResult.form;
    }

    const { data: tenantRecord } = await supabase
      .from('tenant')
      .select('domain, slug')
      .eq('id', tenantCtx.tenantId)
      .single();

    const tenantHost = tenantRecord?.domain || `${tenantRecord?.slug || 'app'}.iconn.app`;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${protocol}://${tenantHost}`;

    const buildFormUrl = (slug) =>
      `${baseUrl}/FormView?slug=${encodeURIComponent(slug)}&brief_id=${encodeURIComponent(briefId)}`;

    const permissionUrl = buildFormUrl(permissionForm.slug);
    const copyrightUrl = copyrightForm ? buildFormUrl(copyrightForm.slug) : null;

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

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="color: #333; font-size: 15px; line-height: 1.6;">
          ${email_content}
        </div>
        ${renderButton(permissionUrl, 'Complete the Permission Form')}
        ${copyrightUrl ? renderButton(copyrightUrl, 'Complete the Copyright Assignment Form') : ''}
      </div>
    `;

    const emailResult = await sendEmail({
      to: provider.email,
      subject: `Case Study Form${copyrightForm ? 's' : ''}: ${brief.title || 'Article Brief'}`,
      html: emailHtml,
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
      case_study_email_content: email_content,
      case_study_form_sent_at: now,
      case_study_submission_id: null,
      case_study_copyright_form_id: copyright_form_id || null,
      case_study_copyright_form_sent_at: copyright_form_id ? now : null,
      case_study_copyright_submission_id: null,
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

    console.log(`[SendCaseStudyForm] Form link${copyrightForm ? 's' : ''} sent to ${provider.email} for brief ${briefId}`);

    return res.status(200).json({
      success: true,
      message: copyrightForm
        ? 'Case study form links sent successfully'
        : 'Case study form link sent successfully',
      sent_at: now,
    });
  } catch (error) {
    console.error('[SendCaseStudyForm] Error:', error);
    return res.status(500).json({ error: 'Failed to send case study form: ' + (error.message || 'Unknown error') });
  }
}
