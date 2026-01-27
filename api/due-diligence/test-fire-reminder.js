import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

// Helper to escape regex special characters
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace [[placeholder]] style placeholders with actual values
function replaceDoubleBracketPlaceholders(text, placeholders) {
  if (!text) return text;
  let result = text;
  for (const [key, value] of Object.entries(placeholders)) {
    const placeholder = `[[${key}]]`;
    result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value || '');
  }
  return result;
}

// Helper to fetch email footer for preview (tenant-scoped)
async function getEmailFooterForPreview(tenantId) {
  try {
    if (!supabase) return null;
    if (!tenantId) {
      console.log('[test-fire-reminder] No tenantId provided for footer lookup');
      return null;
    }

    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'email_footer_html')
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) {
      console.log(`[test-fire-reminder] No email footer for tenant: ${tenantId}`);
      return null;
    }

    let footer = data.setting_value;

    // Replace social placeholders (also tenant-scoped)
    const { data: socialData } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'social_icons_config')
      .eq('tenant_id', tenantId)
      .single();

    if (socialData?.setting_value) {
      try {
        const socialConfig = JSON.parse(socialData.setting_value);
        if (socialConfig.linkedin?.url) footer = footer.replace(/\{\{linkedin_url\}\}/g, socialConfig.linkedin.url);
        if (socialConfig.twitter?.url) footer = footer.replace(/\{\{twitter_url\}\}/g, socialConfig.twitter.url);
        if (socialConfig.facebook?.url) footer = footer.replace(/\{\{facebook_url\}\}/g, socialConfig.facebook.url);
        if (socialConfig.instagram?.url) footer = footer.replace(/\{\{instagram_url\}\}/g, socialConfig.instagram.url);
        if (socialConfig.youtube?.url) footer = footer.replace(/\{\{youtube_url\}\}/g, socialConfig.youtube.url);
      } catch (e) {
        console.error('[test-fire-reminder] Error parsing social config:', e);
      }
    }

    return footer;
  } catch (err) {
    console.error('[test-fire-reminder] Error fetching footer:', err);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantContext.tenantId;
  const { 
    contractInstanceId, 
    reminderId, 
    signerEmail,
    dryRun = true 
  } = req.body;

  if (!contractInstanceId || !reminderId || !signerEmail) {
    return res.status(400).json({ 
      error: 'Missing required fields: contractInstanceId, reminderId, signerEmail' 
    });
  }

  try {
    const now = new Date();
    const result = {
      success: false,
      dryRun,
      timestamp: now.toISOString(),
      contractInstanceId,
      reminderId,
      signerEmail,
      checks: [],
      action: null,
      emailDetails: null,
      error: null
    };

    // Log incoming parameters for debugging
    console.log('[test-fire-reminder] Request params:', { contractInstanceId, reminderId, signerEmail, tenantId });

    // First fetch the contract instance
    const { data: instance, error: instanceError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('id', contractInstanceId)
      .eq('tenant_id', tenantId)
      .single();

    if (instanceError || !instance) {
      console.log('[test-fire-reminder] Contract instance lookup failed:', { contractInstanceId, instanceError });
      result.checks.push({ 
        check: 'Contract instance exists', 
        passed: false, 
        reason: instanceError?.message || `Not found (ID: ${contractInstanceId})`
      });
      return res.status(404).json(result);
    }
    result.checks.push({ check: 'Contract instance exists', passed: true, details: { instanceId: instance.id } });

    // Tenant is already verified by the query filter above
    result.checks.push({ check: 'Tenant authorization', passed: true });

    // Fetch the form separately
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, slug, tenant_id, contract_settings')
      .eq('id', instance.form_id)
      .single();

    if (formError || !form) {
      result.checks.push({ check: 'Form linked', passed: false, reason: 'No form linked to instance' });
      return res.status(400).json(result);
    }
    result.checks.push({ check: 'Form linked', passed: true, details: { formName: form.name } });

    if (instance.status !== 'out_for_signing') {
      result.checks.push({ 
        check: 'Contract status is out_for_signing', 
        passed: false, 
        reason: `Current status: ${instance.status}` 
      });
      result.action = 'skipped';
      result.error = `CRON would skip: Contract status is ${instance.status}, not out_for_signing`;
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Contract status is out_for_signing', passed: true });

    const contractSettings = form.contract_settings || {};
    const reminders = contractSettings.reminders || [];
    const signers = instance.signers || [];
    const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
    const sentAt = instance.sent_at;

    // CRON skips if no reminders or signers configured
    if (reminders.length === 0) {
      result.checks.push({ check: 'Reminders configured', passed: false, reason: 'No reminders configured in contract settings' });
      result.action = 'skipped';
      result.error = 'CRON would skip: No reminders configured';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Reminders configured', passed: true, details: { count: reminders.length } });

    if (signers.length === 0) {
      result.checks.push({ check: 'Signers exist', passed: false, reason: 'No signers in contract instance' });
      result.action = 'skipped';
      result.error = 'CRON would skip: No signers configured';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Signers exist', passed: true, details: { count: signers.length } });

    if (!sentAt) {
      result.checks.push({ check: 'Contract has been sent', passed: false, reason: 'sent_at is null' });
      result.action = 'skipped';
      result.error = 'CRON would skip: Contract has not been sent yet';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Contract has been sent', passed: true, details: { sentAt } });

    const sentDate = new Date(sentAt);
    const expiryDate = new Date(sentDate);
    expiryDate.setDate(expiryDate.getDate() + timeoutDays);

    if (now > expiryDate) {
      result.checks.push({ 
        check: 'Contract not expired', 
        passed: false, 
        reason: `Expired on ${expiryDate.toISOString()}` 
      });
      result.action = 'skipped';
      result.error = 'CRON would skip: Contract has expired';
      return res.status(200).json(result);
    }
    result.checks.push({ 
      check: 'Contract not expired', 
      passed: true, 
      details: { expiryDate: expiryDate.toISOString(), timeoutDays } 
    });

    const reminder = reminders.find(r => r.id === reminderId);
    if (!reminder) {
      result.checks.push({ check: 'Reminder config exists', passed: false, reason: `Reminder ${reminderId} not found in contract settings` });
      result.action = 'skipped';
      result.error = 'Reminder configuration not found';
      return res.status(400).json(result);
    }
    result.checks.push({ check: 'Reminder config exists', passed: true, details: reminder });

    const signer = signers.find(s => (s.email || '').toLowerCase() === signerEmail.toLowerCase());
    if (!signer) {
      result.checks.push({ check: 'Signer exists', passed: false, reason: `Signer ${signerEmail} not in signers list` });
      result.action = 'skipped';
      result.error = 'Signer not found in contract signers';
      return res.status(400).json(result);
    }
    result.checks.push({ check: 'Signer exists', passed: true, details: { signerEmail: signer.email } });

    const { data: submissions } = await supabase
      .from('form_submission')
      .select('*')
      .eq('contract_instance_id', instance.id);

    const signedEmails = new Set();
    (submissions || []).forEach(sub => {
      const data = sub.submission_data || sub.data;
      if (data) {
        const email = data.signer_email || data.email || sub.submitted_by_email;
        if (email) signedEmails.add(email.toLowerCase());
      }
    });

    const hasSigned = signedEmails.has(signerEmail.toLowerCase());
    if (hasSigned) {
      result.checks.push({ check: 'Signer has not signed', passed: false, reason: 'Signer already signed' });
      result.action = 'skipped';
      result.error = 'CRON would skip: Signer has already signed the contract';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Signer has not signed', passed: true });

    const daysSinceSent = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));
    const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

    const reminderDays = reminder.days || reminder.days_before_timeout || 7;
    const timingType = reminder.timing_type || 'before_timeout';

    let isInWindow = false;
    if (timingType === 'before_timeout') {
      isInWindow = daysUntilExpiry <= reminderDays && daysUntilExpiry > (reminderDays - 1);
    } else if (timingType === 'after_first_send') {
      isInWindow = daysSinceSent >= reminderDays && daysSinceSent < (reminderDays + 1);
    }

    result.checks.push({
      check: 'Reminder timing window',
      passed: isInWindow,
      details: {
        timingType,
        reminderDays,
        daysSinceSent,
        daysUntilExpiry,
        isInWindow
      },
      reason: isInWindow ? 'Currently in sending window' : 'Not in sending window'
    });

    if (!isInWindow) {
      result.action = 'would_skip';
      result.error = `CRON would skip: Not in the reminder window. ${timingType === 'before_timeout' ? `Needs ${reminderDays} days until expiry, currently ${daysUntilExpiry}` : `Needs ${reminderDays} days since sent, currently ${daysSinceSent}`}`;
    }

    const signerIdentifier = signer.id || signer.email;
    const reminderKey = `${instance.id}_${signerIdentifier}_${reminder.id}_${now.toISOString().split('T')[0]}`;

    const { data: existingReminder } = await supabase
      .from('contract_reminder_log')
      .select('id, sent_at')
      .eq('reminder_key', reminderKey)
      .single();

    if (existingReminder) {
      result.checks.push({ 
        check: 'Reminder not already sent today', 
        passed: false, 
        reason: `Already sent at ${existingReminder.sent_at}` 
      });
      result.action = 'skipped';
      result.error = 'CRON would skip: Reminder already sent today';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Reminder not already sent today', passed: true, details: { reminderKey } });

    const { data: tenant } = await supabase
      .from('tenant')
      .select('*')
      .eq('id', tenantId)
      .single();

    // Fetch organization data for [[organization.name]] placeholder
    // Try instance.organization_id first, then fallback to form_submission
    let organizationName = '';
    if (instance.organization_id) {
      const { data: org } = await supabase
        .from('organization')
        .select('id, name')
        .eq('id', instance.organization_id)
        .single();
      organizationName = org?.name || '';
    }
    
    // Fallback: try to get organization from form_submission
    if (!organizationName && instance.form_submission_id) {
      const { data: submission } = await supabase
        .from('form_submission')
        .select('organization_id, created_organization_id')
        .eq('id', instance.form_submission_id)
        .single();
      
      const orgId = submission?.organization_id || submission?.created_organization_id;
      if (orgId) {
        const { data: org } = await supabase
          .from('organization')
          .select('id, name')
          .eq('id', orgId)
          .single();
        organizationName = org?.name || '';
      }
    }

    const tenantSlug = tenant?.slug || '';
    const appUrl = process.env.APP_URL || process.env.VERCEL_URL || 'https://iconn.app';
    const signingUrl = tenantSlug 
      ? `https://${tenantSlug}.iconn.app/form/${form.slug}?contract_instance=${instance.id}&signer_email=${encodeURIComponent(signer.email)}`
      : `${appUrl}/form/${form.slug}?contract_instance=${instance.id}&signer_email=${encodeURIComponent(signer.email)}`;

    const signerName = signer.first_name 
      ? `${signer.first_name} ${signer.last_name || ''}`.trim()
      : signer.name || 'Signer';
    
    // Build [[...]] style placeholder values
    const doubleBracketPlaceholders = {
      'organization.name': organizationName,
      'tenant.name': tenant?.name || '',
      'signer.name': signerName,
      'signer.first_name': signer.first_name || '',
      'signer.last_name': signer.last_name || '',
      'signer.email': signer.email || ''
    };

    let emailSubject = `Reminder: Please sign ${form.name}`;
    let emailBody = `
      <p>Dear ${signerName},</p>
      <p>This is a reminder that you have a pending contract to sign: <strong>${form.name}</strong></p>
      <p>The contract will expire in ${daysUntilExpiry} day(s).</p>
      <p>Please click the link below to sign the contract:</p>
      <p><a href="${signingUrl}">Sign Contract</a></p>
      <p>Thank you.</p>
    `;
    let templateUsed = null;

    if (reminder.email_template_id) {
      const { data: template } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', reminder.email_template_id)
        .single();

      if (template) {
        templateUsed = { id: template.id, name: template.name };
        emailSubject = template.subject
          .replace(/{{contract_name}}/g, form.name)
          .replace(/{{signer_name}}/g, signerName)
          .replace(/{{signer_first_name}}/g, signer.first_name || signerName)
          .replace(/{{signer_last_name}}/g, signer.last_name || '')
          .replace(/{{days_remaining}}/g, daysUntilExpiry.toString())
          .replace(/{{days_since_sent}}/g, daysSinceSent.toString());
        
        emailBody = template.body
          .replace(/{{contract_name}}/g, form.name)
          .replace(/{{signer_name}}/g, signerName)
          .replace(/{{signer_first_name}}/g, signer.first_name || signerName)
          .replace(/{{signer_last_name}}/g, signer.last_name || '')
          .replace(/{{days_remaining}}/g, daysUntilExpiry.toString())
          .replace(/{{days_since_sent}}/g, daysSinceSent.toString())
          .replace(/{{sign_url}}/g, signingUrl)
          .replace(/{{signing_url}}/g, signingUrl);
        
        // Replace [[...]] style placeholders (e.g., [[organization.name]])
        emailSubject = replaceDoubleBracketPlaceholders(emailSubject, doubleBracketPlaceholders);
        emailBody = replaceDoubleBracketPlaceholders(emailBody, doubleBracketPlaceholders);
      }
    }

    // Fetch email footer for preview
    const emailFooter = await getEmailFooterForPreview(tenantId);
    // Convert newlines to <br> for HTML preview
    const emailBodyHtml = emailBody.replace(/\n/g, '<br>');
    const fullEmailBody = emailFooter ? emailBodyHtml + emailFooter : emailBodyHtml;

    result.emailDetails = {
      to: signer.email,
      subject: emailSubject,
      bodyHtml: fullEmailBody,
      bodyPreview: emailBody.substring(0, 500) + (emailBody.length > 500 ? '...' : ''),
      templateUsed,
      signingUrl,
      hasFooter: !!emailFooter
    };

    if (dryRun) {
      if (isInWindow) {
        result.success = true;
        result.action = 'would_send';
        result.checks.push({ check: 'Dry run mode', passed: true, reason: 'Email would be sent (dry run)' });
      }
      return res.status(200).json(result);
    }

    try {
      await sendEmail({
        to: signer.email,
        subject: emailSubject,
        body: emailBody,
        tenantId,
        tenant
      });

      await supabase
        .from('contract_reminder_log')
        .insert({
          reminder_key: reminderKey,
          contract_instance_id: instance.id,
          signer_email: signer.email,
          sent_at: now.toISOString(),
          tenant_id: tenantId
        });

      result.success = true;
      result.action = 'sent';
      result.checks.push({ check: 'Email sent', passed: true });

      return res.status(200).json(result);
    } catch (emailError) {
      result.success = false;
      result.action = 'failed';
      result.error = emailError.message || 'Failed to send email';
      result.checks.push({ check: 'Email sent', passed: false, reason: result.error });
      return res.status(500).json(result);
    }

  } catch (error) {
    console.error('[test-fire-reminder] Error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}
