import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import crypto from 'crypto';

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
      console.log('[test-fire-timeout] No tenantId provided for footer lookup');
      return null;
    }

    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'email_footer_html')
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) {
      console.log(`[test-fire-timeout] No email footer for tenant: ${tenantId}`);
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
        console.error('[test-fire-timeout] Error parsing social config:', e);
      }
    }

    return footer;
  } catch (err) {
    console.error('[test-fire-timeout] Error fetching footer:', err);
    return null;
  }
}

function generateToken(contractId, round, secret) {
  const data = `${contractId}:${round}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Helper to build email details for preview
async function buildEmailDetails(params) {
  const {
    tenantId,
    instance,
    form,
    contractSettings,
    sourceSubmission,
    applicantEmail,
    applicantName,
    emailTemplate,
    tenant
  } = params;

  const tenantSlug = tenant?.slug || 'app';
  const tokenSecret = process.env.ALTERNATIVE_SIGNER_TOKEN_SECRET || process.env.SESSION_SECRET || 'default-secret';
  const currentRound = instance.timeout_notification_round || 0;
  const token = generateToken(instance.id, currentRound.toString(), tokenSecret);
  const alternativeSignerLink = `https://${tenantSlug}.iconn.app/embed/alternative-signer?contract=${instance.id}&token=${token}&tenant=${tenantSlug}&round=${currentRound}`;
  const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;

  const placeholders = {
    applicant_name: applicantName,
    first_name: applicantName,
    contract_name: form.name,
    organization_name: '',
    alternative_signer_link: alternativeSignerLink,
    alternative_signer_url: alternativeSignerLink,
    tenant_name: tenant?.name || '',
    timeout_days: timeoutDays.toString()
  };

  // Fetch organization name from instance.organization_id first
  if (instance.organization_id) {
    const { data: org } = await supabase
      .from('organization')
      .select('name')
      .eq('id', instance.organization_id)
      .single();
    placeholders.organization_name = org?.name || '';
  }

  // Also try to get organization from form_submission if not found via instance.organization_id
  let organizationName = placeholders.organization_name;
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
      placeholders.organization_name = organizationName;
    }
  }

  let emailBody = emailTemplate.body || '';
  let emailSubject = emailTemplate.subject || 'Contract Signing Timeout';

  // Replace {{...}} style placeholders
  for (const [key, value] of Object.entries(placeholders)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    emailBody = emailBody.replace(regex, value || '');
    emailSubject = emailSubject.replace(regex, value || '');
  }

  // Replace [[...]] style placeholders (e.g., [[organization.name]])
  const doubleBracketPlaceholders = {
    'organization.name': organizationName || '',
    'tenant.name': tenant?.name || '',
    'applicant.name': applicantName,
    'contract.name': form.name
  };
  emailSubject = replaceDoubleBracketPlaceholders(emailSubject, doubleBracketPlaceholders);
  emailBody = replaceDoubleBracketPlaceholders(emailBody, doubleBracketPlaceholders);

  const senderEmail = tenant?.sender_email || tenant?.contact_email || 'noreply@iconn.app';
  const senderName = tenant?.sender_name || tenant?.name || 'Contracts';

  // Fetch email footer for preview
  const emailFooter = await getEmailFooterForPreview(tenantId);
  const fullEmailBody = emailFooter ? emailBody + emailFooter : emailBody;

  return {
    to: applicantEmail,
    from: `${senderName} <${senderEmail}>`,
    subject: emailSubject,
    bodyHtml: fullEmailBody,
    bodyPreview: emailBody.substring(0, 500) + (emailBody.length > 500 ? '...' : ''),
    templateUsed: { id: emailTemplate.id, name: emailTemplate.name },
    alternativeSignerLink,
    hasFooter: !!emailFooter
  };
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
    dryRun = true 
  } = req.body;

  if (!contractInstanceId) {
    return res.status(400).json({ 
      error: 'Missing required field: contractInstanceId' 
    });
  }

  try {
    const now = new Date();
    const result = {
      success: false,
      dryRun,
      timestamp: now.toISOString(),
      contractInstanceId,
      checks: [],
      action: null,
      emailDetails: null,
      error: null
    };

    // Log incoming parameters for debugging
    console.log('[test-fire-timeout] Request params:', { contractInstanceId, tenantId });

    // First fetch the contract instance
    const { data: instance, error: instanceError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('id', contractInstanceId)
      .eq('tenant_id', tenantId)
      .single();

    if (instanceError || !instance) {
      console.log('[test-fire-timeout] Contract instance lookup failed:', { contractInstanceId, instanceError });
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

    const contractSettings = form.contract_settings || {};

    if (!contractSettings.timeout_email_template_id) {
      result.checks.push({ 
        check: 'Timeout email template configured', 
        passed: false, 
        reason: 'No timeout_email_template_id in contract settings' 
      });
      result.action = 'skipped';
      result.error = 'CRON would skip: No timeout email template configured';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Timeout email template configured', passed: true });

    // ========== PHASE 1: Gather all data needed for email preview ==========
    
    // Check for form_submission_id early so we can build preview
    let sourceSubmission = null;
    if (instance.form_submission_id) {
      const { data: submission, error: submissionError } = await supabase
        .from('form_submission')
        .select('*, form:form_id(id, name, fields)')
        .eq('id', instance.form_submission_id)
        .single();
      
      if (!submissionError && submission) {
        sourceSubmission = submission;
      }
    }

    const submissionData = sourceSubmission?.submission_data || {};
    const applicantEmailField = contractSettings.applicant_email_field;
    const applicantNameField = contractSettings.applicant_name_field;
    const applicantEmail = applicantEmailField ? submissionData[applicantEmailField] : null;
    const applicantName = applicantNameField ? (submissionData[applicantNameField] || 'Applicant') : 'Applicant';

    // Fetch email template
    const { data: emailTemplate, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', contractSettings.timeout_email_template_id)
      .single();

    // Fetch tenant info
    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, slug, name, contact_email, sender_email, sender_name')
      .eq('id', tenantId)
      .single();

    // ========== PHASE 2: Build email preview (always attempt, even with partial data) ==========
    
    // Always try to build email preview so it's shown in UI even when CRON would skip
    const previewApplicantEmail = applicantEmail || '[applicant email not found]';
    const previewApplicantName = applicantName || 'Applicant';
    
    if (emailTemplate) {
      result.emailDetails = await buildEmailDetails({
        tenantId,
        instance,
        form,
        contractSettings,
        sourceSubmission,
        applicantEmail: previewApplicantEmail,
        applicantName: previewApplicantName,
        emailTemplate,
        tenant
      });
      
      // Add warning if preview data is incomplete
      if (!applicantEmail) {
        result.emailDetails.previewWarning = 'Applicant email not found - preview uses placeholder';
      }
    } else if (contractSettings.timeout_email_template_id) {
      // Template configured but not found or fetch failed - create minimal preview info
      const isTemplateError = !!templateError;
      result.emailDetails = {
        to: previewApplicantEmail,
        from: `${tenant?.sender_name || 'Contracts'} <${tenant?.sender_email || tenant?.contact_email || 'noreply@iconn.app'}>`,
        subject: '[Template not found]',
        bodyHtml: '<p>Email template could not be loaded.</p>',
        bodyPreview: 'Email template could not be loaded.',
        templateUsed: { id: contractSettings.timeout_email_template_id, name: 'Template not found' },
        previewWarning: isTemplateError 
          ? `Template fetch error: ${templateError?.message || 'Unknown error'}` 
          : 'Email template not found in database',
        previewIncomplete: true,
        hasFooter: false
      };
    }
    
    // Add previewIncomplete flag for UI to highlight partial previews
    if (result.emailDetails && !applicantEmail) {
      result.emailDetails.previewIncomplete = true;
    }

    // ========== PHASE 3: Run validation checks (with early returns that still include emailDetails) ==========

    const signers = instance.signers || [];
    const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
    const sentAt = instance.sent_at;

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

    const isExpired = now > expiryDate;
    result.checks.push({ 
      check: 'Contract has expired', 
      passed: isExpired, 
      details: { expiryDate: expiryDate.toISOString(), timeoutDays },
      reason: isExpired ? 'Contract has expired' : `Not yet expired (${Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24))} days remaining)`
    });

    if (!isExpired) {
      result.action = 'would_skip';
      result.error = 'CRON would skip: Contract has not expired yet';
      return res.status(200).json(result);
    }

    const hasWinner = signers.some(s => s.status === 'received' || s.signed_at);
    result.checks.push({ 
      check: 'No signer has signed yet', 
      passed: !hasWinner, 
      reason: hasWinner ? 'At least one signer has signed' : 'No signers have signed'
    });

    if (hasWinner) {
      result.action = 'skipped';
      result.error = 'CRON would skip: Contract has a winner (someone signed)';
      return res.status(200).json(result);
    }

    if (instance.timeout_notification_sent_at) {
      const lastNotification = new Date(instance.timeout_notification_sent_at);
      const hoursSinceNotification = (now - lastNotification) / (1000 * 60 * 60);
      const cooldownPassed = hoursSinceNotification >= 24;
      
      result.checks.push({ 
        check: 'Cooldown period passed', 
        passed: cooldownPassed, 
        details: { 
          lastNotificationAt: instance.timeout_notification_sent_at,
          hoursSince: Math.round(hoursSinceNotification * 10) / 10 
        },
        reason: cooldownPassed ? 'Cooldown passed' : `Must wait ${Math.round(24 - hoursSinceNotification)} more hours`
      });

      if (!cooldownPassed) {
        result.action = 'would_skip';
        result.error = 'CRON would skip: Cooldown period not passed (24h between notifications)';
        // emailDetails is already populated, so it will be included in the response
        return res.status(200).json(result);
      }
    } else {
      result.checks.push({ check: 'Cooldown period passed', passed: true, reason: 'No previous notification sent' });
    }

    // Source submission check
    if (!instance.form_submission_id || !sourceSubmission) {
      result.checks.push({ check: 'Source submission exists', passed: false, reason: 'No form_submission_id linked or submission not found' });
      result.action = 'skipped';
      result.error = 'CRON would skip: No source submission linked to contract';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Source submission exists', passed: true });

    // Applicant email field check
    if (!applicantEmailField) {
      result.checks.push({ check: 'Applicant email field configured', passed: false, reason: 'No applicant_email_field in contract settings' });
      result.action = 'skipped';
      result.error = 'CRON would skip: No applicant email field configured';
      return res.status(200).json(result);
    }

    if (!applicantEmail) {
      result.checks.push({ check: 'Applicant email found', passed: false, reason: `Field "${applicantEmailField}" is empty` });
      result.action = 'skipped';
      result.error = 'CRON would skip: Applicant email not found in submission';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Applicant email found', passed: true, details: { applicantEmail, applicantName } });

    // Email template check
    if (templateError || !emailTemplate) {
      result.checks.push({ check: 'Email template exists', passed: false, reason: 'Template not found' });
      result.action = 'skipped';
      result.error = 'CRON would skip: Email template not found';
      return res.status(200).json(result);
    }
    result.checks.push({ check: 'Email template exists', passed: true, details: { templateName: emailTemplate.name } });

    // ========== PHASE 4: All checks passed - ready to send ==========

    if (dryRun) {
      result.success = true;
      result.action = 'would_send';
      result.checks.push({ check: 'Dry run mode', passed: true, reason: 'Email would be sent (dry run)' });
      return res.status(200).json(result);
    }

    // Actually send the email - guard against missing emailDetails
    if (!result.emailDetails || !applicantEmail || !emailTemplate) {
      result.success = false;
      result.action = 'failed';
      result.error = 'Cannot send: missing email details, applicant email, or template';
      return res.status(400).json(result);
    }
    
    try {
      await sendEmail({
        to: applicantEmail, // Use actual applicantEmail, not preview placeholder
        from: result.emailDetails.from,
        subject: result.emailDetails.subject,
        html: result.emailDetails.bodyHtml,
        tenantId
      });

      const { error: updateError } = await supabase
        .from('contract_instance')
        .update({
          timeout_notification_sent_at: now.toISOString(),
          status: 'expired',
          updated_at: now.toISOString()
        })
        .eq('id', instance.id);

      if (updateError) {
        console.warn(`[test-fire-timeout] Failed to update instance ${instance.id}:`, updateError);
      }

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
    console.error('[test-fire-timeout] Error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}
