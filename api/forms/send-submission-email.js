import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { 
      form_id,
      submission_id,
      form_values,
      fields
    } = req.body;

    console.log('[FormSubmissionEmail] Request received for form:', form_id, 'submission:', submission_id);

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

    // Build list of emails to send
    let emailsToSend = [];

    // Check for new multi-email format (submission_emails array)
    if (form.submission_emails && Array.isArray(form.submission_emails) && form.submission_emails.length > 0) {
      console.log('[FormSubmissionEmail] Using new multi-email format, count:', form.submission_emails.length);
      emailsToSend = form.submission_emails.filter(e => e.template_id && e.recipient);
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

    // Get member/org data for system placeholders
    const { data: submission, error: submissionError } = submission_id 
      ? await supabase.from('form_submission').select('member_id, organization_id').eq('id', submission_id).single()
      : { data: null, error: null };

    let memberData = null;
    let organizationData = null;

    if (submission?.member_id) {
      const { data } = await supabase.from('member').select('id, full_name, email, phone').eq('id', submission.member_id).single();
      memberData = data;
    }

    if (submission?.organization_id) {
      const { data } = await supabase.from('organization').select('id, name, invoicing_email, phone').eq('id', submission.organization_id).single();
      organizationData = data;
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

    // Helper to replace placeholders in template content
    const replacePlaceholders = (text, emailConfig) => {
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
        'member.full_name': memberData?.full_name || '',
        'member.email': memberData?.email || '',
        'member.phone': memberData?.phone || '',
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
        'member.full_name': memberData?.full_name || '',
        'member.email': memberData?.email || '',
        'member.phone': memberData?.phone || '',
        'organization.id': organizationData?.id || '',
        'organization.name': organizationData?.name || '',
        'organization.invoicing_email': organizationData?.invoicing_email || '',
        'organization.phone': organizationData?.phone || ''
      };
      
      for (const [key, value] of Object.entries(systemPlaceholders)) {
        const placeholder = `{{${key}}}`;
        result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
      }

      return result;
    };

    // Process each email configuration
    const results = [];
    
    for (const emailConfig of emailsToSend) {
      console.log('[FormSubmissionEmail] Processing email:', emailConfig.id, 'template:', emailConfig.template_id);
      
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

      // Replace placeholders in template
      const emailSubject = replacePlaceholders(template.subject || 'Form Submission', emailConfig);
      const emailBody = replacePlaceholders(template.body || '', emailConfig);

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
