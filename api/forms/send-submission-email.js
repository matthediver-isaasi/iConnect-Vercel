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
    console.log('[FormSubmissionEmail] Email settings - template_id:', form.submission_email_template_id);
    console.log('[FormSubmissionEmail] Email settings - recipient:', form.submission_email_recipient);
    console.log('[FormSubmissionEmail] Email settings - cc:', form.submission_email_cc);
    console.log('[FormSubmissionEmail] Email settings - bcc:', form.submission_email_bcc);

    // Check if email on submission is enabled
    if (!form.submission_email_template_id || !form.submission_email_recipient) {
      console.log('[FormSubmissionEmail] Email on submission not configured - skipping');
      return res.json({ success: true, skipped: true, reason: 'Email on submission not configured' });
    }

    // Get the email template
    const { data: template, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', form.submission_email_template_id)
      .single();

    if (templateError || !template) {
      console.log('[FormSubmissionEmail] Email template not found:', form.submission_email_template_id, templateError);
      return res.status(404).json({ error: 'Email template not found' });
    }

    console.log('[FormSubmissionEmail] Template loaded:', template.name);

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

    // Resolve the recipient email address
    const toEmail = resolveEmailAddress(form.submission_email_recipient);
    const ccEmail = form.submission_email_cc ? resolveEmailAddress(form.submission_email_cc) : '';
    const bccEmail = form.submission_email_bcc ? resolveEmailAddress(form.submission_email_bcc) : '';

    console.log('[FormSubmissionEmail] Resolved emails - to:', toEmail, 'cc:', ccEmail, 'bcc:', bccEmail);

    if (!toEmail) {
      console.log('[FormSubmissionEmail] No valid recipient email resolved');
      return res.json({ success: false, error: 'No valid recipient email' });
    }

    // Replace placeholders in template with form values
    let emailSubject = template.subject || 'Form Submission';
    let emailBody = template.body || '';

    // Replace form field placeholders
    if (form_values && fields) {
      for (const field of fields) {
        const fieldValue = form_values[field.id];
        const placeholder = `{{${field.id}}}`;
        const labelPlaceholder = `{{${field.label}}}`;
        const displayValue = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '');
        
        emailSubject = emailSubject.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayValue);
        emailSubject = emailSubject.replace(new RegExp(labelPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayValue);
        emailBody = emailBody.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayValue);
        emailBody = emailBody.replace(new RegExp(labelPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayValue);
      }
    }

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

    if (emailResult.success) {
      return res.json({ 
        success: true, 
        messageId: emailResult.messageId,
        to: toEmail 
      });
    } else {
      return res.json({ 
        success: false, 
        error: emailResult.error 
      });
    }
  } catch (error) {
    console.error('[FormSubmissionEmail] Error:', error);
    res.status(500).json({ error: 'Failed to send submission email', details: error.message });
  }
}
