import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/send-contract-reminders] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const now = new Date();
    
    // Fetch active contract instances that are out for signing
    const { data: contractInstances, error: instancesError } = await supabase
      .from('contract_instance')
      .select(`
        *,
        form:form_id (
          id,
          name,
          slug,
          tenant_id,
          contract_settings
        )
      `)
      .eq('status', 'out_for_signing');

    if (instancesError) {
      // Handle case where table doesn't exist yet
      if (instancesError.code === '42P01') {
        console.log('[cron/send-contract-reminders] contract_instance table not found - migration pending');
        return res.status(200).json({ message: 'Migration pending', processed: 0 });
      }
      console.error('[cron/send-contract-reminders] Instances fetch error:', instancesError);
      return res.status(500).json({ error: 'Failed to fetch contract instances' });
    }

    if (!contractInstances || contractInstances.length === 0) {
      console.log('[cron/send-contract-reminders] No active contract instances found');
      return res.status(200).json({ message: 'No active contracts', processed: 0 });
    }

    console.log(`[cron/send-contract-reminders] Processing ${contractInstances.length} contract instances`);

    let remindersSent = 0;
    let contractsSkipped = 0;
    
    // Cache tenant slugs to avoid repeated queries
    const tenantSlugCache = {};

    for (const instance of contractInstances) {
      try {
        const form = instance.form;
        if (!form) {
          console.log(`[cron/send-contract-reminders] Instance ${instance.id} has no linked form, skipping`);
          continue;
        }
        
        // Cache tenant slug for this instance
        if (form.tenant_id && !tenantSlugCache[form.tenant_id]) {
          tenantSlugCache[form.tenant_id] = await getTenantSlug(form.tenant_id);
        }
        const tenantSlug = tenantSlugCache[form.tenant_id] || '';

        const contractSettings = form.contract_settings || {};
        const reminders = contractSettings.reminders || [];
        const signers = instance.signers || [];
        const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
        const sentAt = instance.sent_at;

        if (reminders.length === 0 || signers.length === 0) {
          continue;
        }

        if (!sentAt) {
          console.log(`[cron/send-contract-reminders] Instance ${instance.id} has not been sent yet, skipping`);
          continue;
        }

        const sentDate = new Date(sentAt);
        const expiryDate = new Date(sentDate);
        expiryDate.setDate(expiryDate.getDate() + timeoutDays);

        if (now > expiryDate) {
          console.log(`[cron/send-contract-reminders] Instance ${instance.id} has expired`);
          continue;
        }

        // Get submissions linked to this contract instance
        const { data: submissions, error: subError } = await supabase
          .from('form_submission')
          .select('*')
          .eq('contract_instance_id', instance.id);

        if (subError && subError.code !== '42703') {
          console.error(`[cron/send-contract-reminders] Submissions fetch error for instance ${instance.id}:`, subError);
          continue;
        }

        // Determine which signers have already completed the form
        const signedEmails = new Set();
        (submissions || []).forEach(sub => {
          const data = sub.submission_data || sub.data;
          if (data) {
            const email = data.signer_email || data.email || sub.submitted_by_email;
            if (email) signedEmails.add(email.toLowerCase());
          }
        });

        const unsignedSigners = signers.filter(s => 
          !signedEmails.has((s.email || '').toLowerCase())
        );

        if (unsignedSigners.length === 0) {
          console.log(`[cron/send-contract-reminders] All signers have signed instance ${instance.id}`);
          contractsSkipped++;
          continue;
        }

        const daysSinceSent = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));
        const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        for (const reminder of reminders) {
          // Support both old 'days_before_timeout' and new 'days' field
          const reminderDays = reminder.days || reminder.days_before_timeout || 7;
          const timingType = reminder.timing_type || 'before_timeout';
          
          let shouldSendReminder = false;
          
          if (timingType === 'before_timeout') {
            // Send X days before timeout
            shouldSendReminder = daysUntilExpiry <= reminderDays && daysUntilExpiry > (reminderDays - 1);
          } else if (timingType === 'after_first_send') {
            // Send X days after first send
            shouldSendReminder = daysSinceSent >= reminderDays && daysSinceSent < (reminderDays + 1);
          }

          if (!shouldSendReminder) {
            continue;
          }

          for (const signer of unsignedSigners) {
            if (!signer.email) continue;

            const signerIdentifier = signer.id || signer.email;
            const reminderKey = `${instance.id}_${signerIdentifier}_${reminder.id}_${now.toISOString().split('T')[0]}`;
            
            // Check if reminder was already sent today
            const { data: existingReminder } = await supabase
              .from('contract_reminder_log')
              .select('id')
              .eq('reminder_key', reminderKey)
              .single();

            if (existingReminder) {
              continue;
            }

            const signerName = signer.first_name 
              ? `${signer.first_name} ${signer.last_name || ''}`.trim()
              : signer.name || 'Signer';

            // Build signing URL using cached tenant slug
            const appUrl = process.env.APP_URL || process.env.VERCEL_URL || 'https://iconn.app';
            const signingUrl = tenantSlug 
              ? `https://${tenantSlug}.iconn.app/form/${form.slug}?contract_instance=${instance.id}&signer_email=${encodeURIComponent(signer.email)}`
              : `${appUrl}/form/${form.slug}?contract_instance=${instance.id}&signer_email=${encodeURIComponent(signer.email)}`;

            let emailSubject = `Reminder: Please sign ${form.name}`;
            let emailBody = `
              <p>Dear ${signerName},</p>
              <p>This is a reminder that you have a pending contract to sign: <strong>${form.name}</strong></p>
              <p>The contract will expire in ${daysUntilExpiry} day(s).</p>
              <p>Please click the link below to sign the contract:</p>
              <p><a href="${signingUrl}">Sign Contract</a></p>
              <p>Thank you.</p>
            `;

            if (reminder.email_template_id) {
              const { data: template } = await supabase
                .from('email_template')
                .select('*')
                .eq('id', reminder.email_template_id)
                .single();

              if (template) {
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
                  .replace(/{{sign_url}}/g, signingUrl);
              }
            }

            const { data: tenant } = await supabase
              .from('tenant')
              .select('*')
              .eq('id', form.tenant_id)
              .single();

            try {
              await sendEmail({
                to: signer.email,
                subject: emailSubject,
                html: emailBody,
                tenantId: form.tenant_id
              });

              await supabase
                .from('contract_reminder_log')
                .insert({
                  reminder_key: reminderKey,
                  contract_instance_id: instance.id,
                  signer_email: signer.email,
                  sent_at: now.toISOString(),
                  tenant_id: form.tenant_id
                });

              remindersSent++;
              console.log(`[cron/send-contract-reminders] Sent reminder for instance ${instance.id} to ${signer.email} (${timingType}: ${reminderDays} days)`);
            } catch (emailError) {
              console.error(`[cron/send-contract-reminders] Failed to send email to ${signer.email}:`, emailError);
            }
          }
        }
      } catch (instanceError) {
        console.error(`[cron/send-contract-reminders] Error processing instance ${instance.id}:`, instanceError);
      }
    }

    console.log(`[cron/send-contract-reminders] Completed. Sent ${remindersSent} reminders, skipped ${contractsSkipped} completed contracts`);

    const endTime = Date.now();
    const durationMs = endTime - now.getTime();

    const tenantsSeen = [...new Set(contractInstances.filter(i => i.form?.tenant_id).map(i => i.form.tenant_id))];
    
    for (const tenantId of tenantsSeen) {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: tenantId,
        task_name: 'contract_reminders',
        task_display_name: 'Contract Reminders',
        status: remindersSent > 0 ? 'success' : 'no_action',
        summary: remindersSent > 0 
          ? `Sent ${remindersSent} reminder${remindersSent !== 1 ? 's' : ''}` 
          : 'No reminders needed at this time',
        details: {
          contracts_checked: contractInstances.length,
          reminders_sent: remindersSent,
          contracts_skipped: contractsSkipped
        },
        items_processed: contractInstances.length,
        items_succeeded: remindersSent,
        items_failed: 0,
        duration_ms: durationMs
      });
    }

    if (tenantsSeen.length === 0) {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'contract_reminders',
        task_display_name: 'Contract Reminders',
        status: 'no_action',
        summary: 'No active contracts to check',
        details: { contracts_checked: 0 },
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0,
        duration_ms: durationMs
      });
    }
    
    return res.status(200).json({ 
      message: 'Contract reminders processed',
      sent: remindersSent,
      skipped: contractsSkipped
    });

  } catch (error) {
    console.error('[cron/send-contract-reminders] Error:', error);
    
    try {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'contract_reminders',
        task_display_name: 'Contract Reminders',
        status: 'failed',
        summary: 'Task failed with error',
        error_message: error.message || 'Unknown error',
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0
      });
    } catch (logError) {
      console.error('[cron/send-contract-reminders] Failed to log error:', logError);
    }
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getTenantSlug(tenantId) {
  try {
    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();
    return tenant?.slug || '';
  } catch {
    return '';
  }
}
