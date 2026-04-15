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

    const { form_id, provider, email_content } = req.body;

    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }
    if (!provider?.email || !provider?.first_name || !provider?.last_name) {
      return res.status(400).json({ error: 'Provider first_name, last_name, and email are required' });
    }
    if (!email_content) {
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
      return res.status(404).json({ error: 'Form not found' });
    }

    if (!form.is_active) {
      return res.status(400).json({ error: 'Form is not active' });
    }

    if (form.require_authentication) {
      return res.status(400).json({ error: 'Cannot use an authentication-required form for external case study providers' });
    }

    if (!form.slug) {
      return res.status(400).json({ error: 'Form does not have a slug configured' });
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

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="color: #333; font-size: 15px; line-height: 1.6;">
          ${email_content}
        </div>
        <div style="margin-top: 24px;">
          <a href="${formUrl}" 
             style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 500;">
            Complete the Form
          </a>
        </div>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          Or copy this link: <a href="${formUrl}" style="color: #2563eb;">${formUrl}</a>
        </p>
      </div>
    `;

    const emailResult = await sendEmail({
      to: provider.email,
      subject: `Case Study Form: ${brief.title || 'Article Brief'}`,
      html: emailHtml,
      tenantId: tenantCtx.tenantId,
      skipFooter: false,
    });

    if (!emailResult || emailResult.success !== true) {
      console.error('[SendCaseStudyForm] Email send failed:', emailResult?.error || 'Unknown error');
      return res.status(500).json({ error: 'Failed to send email: ' + (emailResult?.error || 'Unknown error') });
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('article_brief')
      .update({
        case_study_form_id: form_id,
        case_study_provider: {
          first_name: provider.first_name,
          last_name: provider.last_name,
          email: provider.email,
        },
        case_study_email_content: email_content,
        case_study_form_sent_at: now,
        case_study_submission_id: null,
      })
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[SendCaseStudyForm] Failed to update brief:', updateError);
      return res.status(500).json({ error: 'Email sent but failed to update brief record' });
    }

    console.log(`[SendCaseStudyForm] Form link sent to ${provider.email} for brief ${briefId}`);

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
