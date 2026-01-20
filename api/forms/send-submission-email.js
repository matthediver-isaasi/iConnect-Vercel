import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '../_lib/emailService.js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Generate a password setup URL for new members (7 day validity)
async function generatePasswordSetupUrl(memberId, memberEmail, baseUrl) {
  if (!supabase || !memberId || !memberEmail) return null;
  
  try {
    const email = memberEmail.toLowerCase();
    const resetToken = crypto.randomUUID();
    const resetTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // Check if credentials record exists for this member_id
    const { data: existingCredsByMember } = await supabase
      .from('member_credentials')
      .select('id, email')
      .eq('member_id', memberId)
      .single();
    
    // Also check if credentials exist for this email (potentially different member)
    const { data: existingCredsByEmail } = await supabase
      .from('member_credentials')
      .select('id, member_id')
      .eq('email', email)
      .single();
    
    if (existingCredsByMember) {
      // Update existing record for this member
      console.log(`[FormSubmissionEmail] Updating existing credentials for member_id ${memberId}`);
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({
          email: email,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        })
        .eq('member_id', memberId);
      
      if (updateError) {
        console.error('[FormSubmissionEmail] Error updating reset token:', updateError);
        return null;
      }
    } else if (existingCredsByEmail) {
      // Credentials exist with this email but different member_id
      console.log(`[FormSubmissionEmail] Found credentials by email, updating member_id`);
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({
          member_id: memberId,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        })
        .eq('email', email);
      
      if (updateError) {
        console.error('[FormSubmissionEmail] Error updating credentials by email:', updateError);
        return null;
      }
    } else {
      // No existing credentials - create new record
      console.log(`[FormSubmissionEmail] Creating new credentials for member ${memberId}`);
      const { error: insertError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: memberId,
          email: email,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        });
      
      if (insertError) {
        console.error('[FormSubmissionEmail] Error inserting credentials with reset token:', insertError);
        return null;
      }
    }
    
    console.log(`[FormSubmissionEmail] Generated password setup token for member ${memberId} (${email})`);
    return `${baseUrl}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
  } catch (error) {
    console.error('[FormSubmissionEmail] Error generating password setup URL:', error);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    console.log('[FormSubmissionEmail] === ENDPOINT CALLED ===');
    
    const { 
      form_id,
      submission_id,
      form_values,
      fields,
      created_member_id,       // Member ID from process-application
      created_organization_id, // Organization ID from process-application
      _debug_form_email_config
    } = req.body;

    console.log('[FormSubmissionEmail] Request received for form:', form_id, 'submission:', submission_id);
    console.log('[FormSubmissionEmail] Created member_id:', created_member_id, 'org_id:', created_organization_id);
    console.log('[FormSubmissionEmail] form_values keys:', form_values ? Object.keys(form_values) : 'null');
    
    // Log client-side debug info to help diagnose issues
    if (_debug_form_email_config) {
      console.log('[FormSubmissionEmail] CLIENT-SIDE form email config:', JSON.stringify(_debug_form_email_config));
    }

    if (!form_id) {
      console.log('[FormSubmissionEmail] Missing form_id');
      return res.status(400).json({ error: 'form_id is required' });
    }

    // Get the form with email settings
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('*')
      .eq('id', form_id)
      .single();

    if (formError || !form) {
      console.log('[FormSubmissionEmail] Form not found:', form_id, formError);
      return res.status(404).json({ error: 'Form not found' });
    }

    console.log('[FormSubmissionEmail] Form loaded:', form.name);
    console.log('[FormSubmissionEmail] Form email config - submission_emails:', JSON.stringify(form.submission_emails));
    console.log('[FormSubmissionEmail] Form email config - legacy template_id:', form.submission_email_template_id);
    console.log('[FormSubmissionEmail] Form email config - legacy recipient:', form.submission_email_recipient);

    // Build list of emails to send
    let emailsToSend = [];

    // Check for new multi-email format (submission_emails array)
    if (form.submission_emails && Array.isArray(form.submission_emails) && form.submission_emails.length > 0) {
      console.log('[FormSubmissionEmail] Using new multi-email format, count:', form.submission_emails.length);
      emailsToSend = form.submission_emails.filter(e => e.template_id && e.recipient);
      console.log('[FormSubmissionEmail] Filtered emails to send:', emailsToSend.length);
    } 
    // Fallback to legacy single email format
    else if (form.submission_email_template_id && form.submission_email_recipient) {
      console.log('[FormSubmissionEmail] Using legacy single email format');
      emailsToSend = [{
        id: 'legacy',
        template_id: form.submission_email_template_id,
        recipient: form.submission_email_recipient,
        cc: form.submission_email_cc || '',
        bcc: form.submission_email_bcc || '',
        field_mapping: form.submission_email_field_mapping || {}
      }];
    }

    if (emailsToSend.length === 0) {
      console.log('[FormSubmissionEmail] No emails configured - skipping');
      return res.json({ success: true, skipped: true, reason: 'No emails configured' });
    }

    // Derive base URL for {{set_password_url}} placeholder
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    let host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!host && process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');
    console.log('[FormSubmissionEmail] Derived baseUrl:', baseUrl);

    // Get member/org data for system placeholders
    // Priority: use created_member_id/created_organization_id from process-application if available
    // Otherwise fall back to submission table lookup (for legacy forms)
    let memberIdToUse = created_member_id;
    let organizationIdToUse = created_organization_id;
    
    // Fallback: try to get IDs from the submission record
    if (!memberIdToUse && !organizationIdToUse && submission_id) {
      const { data: submission } = await supabase
        .from('form_submission')
        .select('created_member_id, created_organization_id, member_id, organization_id')
        .eq('id', submission_id)
        .single();
      
      if (submission) {
        memberIdToUse = submission.created_member_id || submission.member_id;
        organizationIdToUse = submission.created_organization_id || submission.organization_id;
      }
    }
    
    console.log('[FormSubmissionEmail] Using member_id:', memberIdToUse, 'organization_id:', organizationIdToUse);

    let memberData = null;
    let organizationData = null;

    if (memberIdToUse) {
      // Retry logic to handle race condition where member was just created
      let retries = 3;
      let delay = 500; // Start with 500ms delay
      
      while (retries > 0 && !memberData) {
        const { data, error } = await supabase
          .from('member')
          .select('id, first_name, last_name, email, organization_id')
          .eq('id', memberIdToUse)
          .single();
        
        if (error) {
          console.error('[FormSubmissionEmail] Error fetching member:', error.message, 'code:', error.code);
        }
        
        if (data) {
          memberData = data;
          console.log('[FormSubmissionEmail] Member data loaded:', `${memberData.first_name} ${memberData.last_name}`, 'email:', memberData.email);
        } else if (retries > 1) {
          console.log('[FormSubmissionEmail] Member not found, retrying in', delay, 'ms... (retries left:', retries - 1, ')');
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        } else {
          console.log('[FormSubmissionEmail] Member not found after all retries');
        }
        retries--;
      }
      
      // If no organizationIdToUse but member has organization_id, use that
      if (!organizationIdToUse && memberData?.organization_id) {
        organizationIdToUse = memberData.organization_id;
      }
    }

    if (organizationIdToUse) {
      const { data } = await supabase
        .from('organization')
        .select('id, name, invoicing_email, phone')
        .eq('id', organizationIdToUse)
        .single();
      organizationData = data;
      console.log('[FormSubmissionEmail] Organization data loaded:', organizationData?.name || 'null');
    }

    // Helper to escape regex special chars
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Helper function to resolve email address from field reference or static value
    const resolveEmailAddress = (value) => {
      if (!value) return '';
      
      // Check if it's a field reference like {{field_id}}
      if (value.startsWith('{{') && value.endsWith('}}')) {
        const fieldId = value.slice(2, -2);
        const fieldValue = form_values?.[fieldId];
        console.log('[FormSubmissionEmail] Resolved field reference', fieldId, 'to:', fieldValue);
        return fieldValue || '';
      }
      
      // It's a static email address
      return value;
    };

    // Helper to replace placeholders in template content (async for set_password_url generation)
    const replacePlaceholders = async (text, emailConfig) => {
      if (!text) return '';
      
      let result = text;
      const fieldMapping = emailConfig.field_mapping || {};
      
      // Replace custom placeholders using the field mapping
      for (const [placeholder, fieldId] of Object.entries(fieldMapping)) {
        if (fieldId && form_values) {
          const fieldValue = form_values[fieldId];
          const displayValue = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '');
          const placeholderPattern = `{{${placeholder}}}`;
          result = result.replace(new RegExp(escapeRegex(placeholderPattern), 'g'), displayValue);
        }
      }

      // Replace form field placeholders (by field ID and label)
      if (form_values && fields) {
        for (const field of fields) {
          const fieldValue = form_values[field.id];
          const placeholder = `{{${field.id}}}`;
          const labelPlaceholder = field.label ? `{{${field.label}}}` : null;
          const displayValue = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '');
          
          result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), displayValue);
          if (labelPlaceholder) {
            result = result.replace(new RegExp(escapeRegex(labelPlaceholder), 'g'), displayValue);
          }
        }
      }

      // Replace [[placeholder]] core database placeholders
      const dbPlaceholders = {
        'member.id': memberData?.id || '',
        'member.first_name': memberData?.first_name || '',
        'member.last_name': memberData?.last_name || '',
        'member.full_name': `${memberData?.first_name || ''} ${memberData?.last_name || ''}`.trim(),
        'member.email': memberData?.email || '',
        'organization.id': organizationData?.id || '',
        'organization.name': organizationData?.name || '',
        'organization.invoicing_email': organizationData?.invoicing_email || '',
        'organization.phone': organizationData?.phone || ''
      };

      for (const [key, value] of Object.entries(dbPlaceholders)) {
        const placeholder = `[[${key}]]`;
        result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
      }

      // Also support legacy {{}} syntax for backwards compatibility
      const systemPlaceholders = {
        'form.name': form.name || '',
        'submission.date': new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
        'member.id': memberData?.id || '',
        'member.first_name': memberData?.first_name || '',
        'member.last_name': memberData?.last_name || '',
        'member.full_name': `${memberData?.first_name || ''} ${memberData?.last_name || ''}`.trim(),
        'member.email': memberData?.email || '',
        'organization.id': organizationData?.id || '',
        'organization.name': organizationData?.name || '',
        'organization.invoicing_email': organizationData?.invoicing_email || '',
        'organization.phone': organizationData?.phone || ''
      };
      
      for (const [key, value] of Object.entries(systemPlaceholders)) {
        const placeholder = `{{${key}}}`;
        result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
      }

      // Handle {{set_password_url}} placeholder - generate password setup URL for member
      const hasSetPasswordPlaceholder = /\{\{\s*set_password_url\s*\}\}/i.test(result);
      if (hasSetPasswordPlaceholder && memberData?.id && memberData?.email && baseUrl) {
        console.log('[FormSubmissionEmail] Detected {{set_password_url}} placeholder, generating URL...');
        const passwordUrl = await generatePasswordSetupUrl(memberData.id, memberData.email, baseUrl);
        if (passwordUrl) {
          // Render as HTML anchor tag with "Set your password" text
          const passwordLink = `<a href="${passwordUrl}" style="color: #0066cc; text-decoration: underline;">Set your password</a>`;
          result = result.replace(/\{\{\s*set_password_url\s*\}\}/gi, passwordLink);
          console.log('[FormSubmissionEmail] Replaced {{set_password_url}} with HTML link');
        } else {
          console.warn('[FormSubmissionEmail] Failed to generate password setup URL');
        }
      } else if (hasSetPasswordPlaceholder) {
        console.warn('[FormSubmissionEmail] {{set_password_url}} placeholder found but missing member data or baseUrl');
        console.log('[FormSubmissionEmail] memberData:', memberData?.id, 'email:', memberData?.email, 'baseUrl:', baseUrl);
      }

      return result;
    };

    // Helper function to evaluate email send condition
    const evaluateCondition = (condition) => {
      if (!condition || !condition.field_id) {
        return true; // No condition = always send
      }
      
      const fieldValue = form_values?.[condition.field_id];
      const conditionValue = condition.value ?? '';
      const operator = condition.operator || 'equals';
      
      // Normalize field value for comparison (use nullish coalescing to preserve 0 and false)
      const normalizedFieldValue = (Array.isArray(fieldValue) 
        ? fieldValue.join(', ') 
        : (fieldValue ?? '')).toString().trim();
      const normalizedConditionValue = conditionValue.toString().trim();
      
      console.log('[FormSubmissionEmail] Evaluating condition:', {
        field_id: condition.field_id,
        operator,
        conditionValue: normalizedConditionValue,
        fieldValue: normalizedFieldValue
      });
      
      switch (operator) {
        case 'equals':
          return normalizedFieldValue.toLowerCase() === normalizedConditionValue.toLowerCase();
        case 'not_equals':
          return normalizedFieldValue.toLowerCase() !== normalizedConditionValue.toLowerCase();
        case 'contains':
          return normalizedFieldValue.toLowerCase().includes(normalizedConditionValue.toLowerCase());
        case 'not_contains':
          return !normalizedFieldValue.toLowerCase().includes(normalizedConditionValue.toLowerCase());
        case 'is_empty':
          return !normalizedFieldValue || normalizedFieldValue.length === 0;
        case 'is_not_empty':
          return normalizedFieldValue && normalizedFieldValue.length > 0;
        default:
          return true;
      }
    };

    // Process each email configuration
    const results = [];
    
    for (const emailConfig of emailsToSend) {
      console.log('[FormSubmissionEmail] Processing email:', emailConfig.id, 'template:', emailConfig.template_id);
      
      // Check send condition
      if (emailConfig.condition && !evaluateCondition(emailConfig.condition)) {
        console.log('[FormSubmissionEmail] Condition not met, skipping email:', emailConfig.id);
        results.push({
          id: emailConfig.id,
          success: true,
          skipped: true,
          reason: 'Condition not met'
        });
        continue;
      }
      
      // Get the email template
      const { data: template, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', emailConfig.template_id)
        .single();

      if (templateError || !template) {
        console.log('[FormSubmissionEmail] Email template not found:', emailConfig.template_id, templateError);
        results.push({
          id: emailConfig.id,
          success: false,
          error: 'Template not found'
        });
        continue;
      }

      console.log('[FormSubmissionEmail] Template loaded:', template.name);

      // Resolve the recipient email address
      const toEmail = resolveEmailAddress(emailConfig.recipient);
      const ccEmail = emailConfig.cc ? resolveEmailAddress(emailConfig.cc) : '';
      const bccEmail = emailConfig.bcc ? resolveEmailAddress(emailConfig.bcc) : '';

      console.log('[FormSubmissionEmail] Resolved emails - to:', toEmail, 'cc:', ccEmail, 'bcc:', bccEmail);

      if (!toEmail) {
        console.log('[FormSubmissionEmail] No valid recipient email resolved');
        results.push({
          id: emailConfig.id,
          success: false,
          error: 'No valid recipient email'
        });
        continue;
      }

      // Replace placeholders in template (async for set_password_url generation)
      const emailSubject = await replacePlaceholders(template.subject || 'Form Submission', emailConfig);
      const emailBody = await replacePlaceholders(template.body || '', emailConfig);

      console.log('[FormSubmissionEmail] Sending email...');
      console.log('[FormSubmissionEmail] Subject:', emailSubject);

      // Send the email
      const emailResult = await sendEmail({
        to: toEmail,
        subject: emailSubject,
        html: emailBody,
        cc: ccEmail || undefined,
        bcc: bccEmail || undefined
      });

      console.log('[FormSubmissionEmail] Email result:', emailResult);

      results.push({
        id: emailConfig.id,
        success: emailResult.success,
        messageId: emailResult.messageId,
        to: toEmail,
        error: emailResult.error
      });
    }

    console.log('[FormSubmissionEmail] All emails processed, results:', results.length);

    return res.json({ 
      success: results.every(r => r.success),
      emails: results 
    });
  } catch (error) {
    console.error('[FormSubmissionEmail] Error:', error);
    res.status(500).json({ error: 'Failed to send submission email', details: error.message });
  }
}
