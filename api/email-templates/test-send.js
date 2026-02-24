import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendEmail, replacePlaceholders } from '../_lib/emailService.js';
import { getTenantBaseUrl } from '../_lib/campaignService.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';
import { generateMemberPreferencesToken } from '../email-preferences/index.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { templateId, memberId, email } = req.body;

  if (!templateId) {
    return res.status(400).json({ error: 'Template ID is required' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  try {
    const { data: template, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', templateId)
      .eq('tenant_id', tenantId)
      .single();

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    let entityType = 'member';
    let entityData = {};

    if (memberId) {
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('*')
        .eq('id', memberId)
        .eq('tenant_id', tenantId)
        .single();

      if (!member || memberError) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const fullName = `${member.first_name || ''} ${member.last_name || ''}`.trim();
      entityData = { ...member, full_name: fullName, recipient_name: fullName };

      if (member.organization_id) {
        const { data: org } = await supabase
          .from('organization')
          .select('*')
          .eq('id', member.organization_id)
          .eq('tenant_id', tenantId)
          .single();

        if (org) {
          entityData.organization_name = org.name;
          entityData.organization_email = org.invoicing_email || org.email;
          entityData.organization_phone = org.phone;
        }
      }
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const requestHost = getHostFromRequest(req);
    const tenantBaseUrl = getTenantBaseUrl(tenant?.slug, requestHost);

    const prefContext = memberId ? { tenantBaseUrl, tenantId, memberId } : null;

    let subject = `[TEST] ${template.subject || 'No Subject'}`;
    let body = template.body || '';

    subject = replacePlaceholders(subject, entityType, entityData, prefContext);
    body = replacePlaceholders(body, entityType, entityData, prefContext);

    if (prefContext) {
      const prefToken = generateMemberPreferencesToken(tenantId, memberId);
      const preferencesUrl = `${tenantBaseUrl}/email-preferences?t=${prefToken}`;
      const preferencesLink = `<a href="${preferencesUrl}" style="color: #666;">Manage communication preferences</a>`;
      body = body.replace(/\{\{communication_preferences_link\}\}/gi, preferencesLink);
      body = body.replace(/\{\{communication_preferences_url\}\}/gi, preferencesUrl);
    }

    if (tenantBaseUrl && memberId) {
      const setPasswordUrl = `${tenantBaseUrl}/set-password?member=${memberId}`;
      subject = subject.replace(/\{\{set_password_url\}\}/gi, setPasswordUrl);
      body = body.replace(/\{\{set_password_url\}\}/gi, setPasswordUrl);
      const setPasswordLink = `<a href="${setPasswordUrl}">Set your password</a>`;
      subject = subject.replace(/\{\{set_password_link\}\}/gi, setPasswordLink);
      body = body.replace(/\{\{set_password_link\}\}/gi, setPasswordLink);
    }

    const result = await sendEmail({
      to: email,
      subject,
      html: body,
      from: template.from_email || undefined,
      replyTo: template.reply_to || undefined,
      tenantId,
    });

    if (result.success) {
      return res.json({ success: true, message: `Test email sent to ${email}` });
    } else {
      return res.status(500).json({ error: result.error || 'Failed to send test email' });
    }
  } catch (err) {
    console.error('[Template Test Send] Error:', err);
    return res.status(500).json({ error: 'Failed to send test email' });
  }
}
