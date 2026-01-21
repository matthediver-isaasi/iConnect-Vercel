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
    
    const { data: contractForms, error: formsError } = await supabase
      .from('form')
      .select('*')
      .eq('is_contract', true)
      .eq('is_active', true);

    if (formsError) {
      console.error('[cron/send-contract-reminders] Forms fetch error:', formsError);
      return res.status(500).json({ error: 'Failed to fetch contract forms' });
    }

    if (!contractForms || contractForms.length === 0) {
      console.log('[cron/send-contract-reminders] No active contract forms found');
      return res.status(200).json({ message: 'No active contracts', processed: 0 });
    }

    console.log(`[cron/send-contract-reminders] Processing ${contractForms.length} contract forms`);

    let remindersSent = 0;
    let contractsSkipped = 0;

    for (const form of contractForms) {
      try {
        const contractSettings = form.contract_settings || {};
        const reminders = contractSettings.reminders || [];
        const signers = contractSettings.signers || [];
        const timeoutDays = contractSettings.timeout_days || 30;
        const sentAt = contractSettings.sent_at;

        if (reminders.length === 0 || signers.length === 0) {
          continue;
        }

        if (!sentAt) {
          console.log(`[cron/send-contract-reminders] Contract ${form.id} has not been sent yet, skipping`);
          continue;
        }

        const sentDate = new Date(sentAt);
        const expiryDate = new Date(sentDate);
        expiryDate.setDate(expiryDate.getDate() + timeoutDays);

        if (now > expiryDate) {
          console.log(`[cron/send-contract-reminders] Contract ${form.id} has expired`);
          continue;
        }

        const { data: submissions, error: subError } = await supabase
          .from('form_submission')
          .select('*')
          .eq('form_id', form.id);

        if (subError) {
          console.error(`[cron/send-contract-reminders] Submissions fetch error for form ${form.id}:`, subError);
          continue;
        }

        const signedEmails = new Set();
        (submissions || []).forEach(sub => {
          if (sub.data) {
            const hasSignature = Object.values(sub.data).some(v => 
              typeof v === 'object' && v?.type === 'signature'
            );
            if (hasSignature) {
              const email = sub.data.signer_email || sub.data.email;
              if (email) signedEmails.add(email.toLowerCase());
            }
          }
        });

        const unsignedSigners = signers.filter(s => 
          !signedEmails.has((s.email || '').toLowerCase())
        );

        if (unsignedSigners.length === 0) {
          console.log(`[cron/send-contract-reminders] All signers have signed contract ${form.id}`);
          contractsSkipped++;
          continue;
        }

        const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        for (const reminder of reminders) {
          const daysBeforeTimeout = reminder.days_before_timeout || 7;
          
          if (daysUntilExpiry <= daysBeforeTimeout && daysUntilExpiry > (daysBeforeTimeout - 1)) {
            for (const signer of unsignedSigners) {
              if (!signer.email) continue;

              const reminderKey = `${form.id}_${signer.id}_${reminder.id}_${now.toISOString().split('T')[0]}`;
              
              const { data: existingReminder } = await supabase
                .from('contract_reminder_log')
                .select('id')
                .eq('reminder_key', reminderKey)
                .single();

              if (existingReminder) {
                continue;
              }

              let emailSubject = `Reminder: Please sign ${form.name}`;
              let emailBody = `
                <p>Dear ${signer.name || 'Signer'},</p>
                <p>This is a reminder that you have a pending contract to sign: <strong>${form.name}</strong></p>
                <p>The contract will expire in ${daysUntilExpiry} day(s).</p>
                <p>Please click the link below to sign the contract:</p>
                <p><a href="${process.env.APP_URL || 'https://your-app.com'}/form/${form.slug}?signer_email=${encodeURIComponent(signer.email)}">Sign Contract</a></p>
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
                    .replace(/{{signer_name}}/g, signer.name || 'Signer')
                    .replace(/{{days_remaining}}/g, daysUntilExpiry.toString());
                  
                  emailBody = template.body
                    .replace(/{{contract_name}}/g, form.name)
                    .replace(/{{signer_name}}/g, signer.name || 'Signer')
                    .replace(/{{days_remaining}}/g, daysUntilExpiry.toString())
                    .replace(/{{sign_url}}/g, `${process.env.APP_URL || 'https://your-app.com'}/form/${form.slug}?signer_email=${encodeURIComponent(signer.email)}`);
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
                  body: emailBody,
                  tenantId: form.tenant_id,
                  tenant
                });

                await supabase
                  .from('contract_reminder_log')
                  .insert({
                    reminder_key: reminderKey,
                    form_id: form.id,
                    signer_email: signer.email,
                    sent_at: now.toISOString(),
                    tenant_id: form.tenant_id
                  });

                remindersSent++;
                console.log(`[cron/send-contract-reminders] Sent reminder for contract ${form.id} to ${signer.email}`);
              } catch (emailError) {
                console.error(`[cron/send-contract-reminders] Failed to send email to ${signer.email}:`, emailError);
              }
            }
          }
        }
      } catch (formError) {
        console.error(`[cron/send-contract-reminders] Error processing form ${form.id}:`, formError);
      }
    }

    console.log(`[cron/send-contract-reminders] Completed. Sent ${remindersSent} reminders, skipped ${contractsSkipped} completed contracts`);
    
    return res.status(200).json({ 
      message: 'Contract reminders processed',
      sent: remindersSent,
      skipped: contractsSkipped
    });

  } catch (error) {
    console.error('[cron/send-contract-reminders] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
