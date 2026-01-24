import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import crypto from 'crypto';

function generateToken(contractId, round, secret) {
  const data = `${contractId}:${round}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/send-contract-timeout-notifications] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const now = new Date();
    
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
      .in('status', ['out_for_signing', 'pending', 'expired']);

    if (instancesError) {
      if (instancesError.code === '42P01') {
        console.log('[cron/send-contract-timeout-notifications] contract_instance table not found - migration pending');
        return res.status(200).json({ message: 'Migration pending', processed: 0 });
      }
      console.error('[cron/send-contract-timeout-notifications] Instances fetch error:', instancesError);
      return res.status(500).json({ error: 'Failed to fetch contract instances' });
    }

    if (!contractInstances || contractInstances.length === 0) {
      console.log('[cron/send-contract-timeout-notifications] No contract instances found');
      return res.status(200).json({ message: 'No contracts to check', processed: 0 });
    }

    console.log(`[cron/send-contract-timeout-notifications] Checking ${contractInstances.length} contract instances`);

    let notificationsSent = 0;
    let contractsSkipped = 0;
    let contractsExpired = 0;
    
    const tenantCache = {};
    const tokenSecret = process.env.ALTERNATIVE_SIGNER_TOKEN_SECRET || process.env.SESSION_SECRET || 'default-secret';

    for (const instance of contractInstances) {
      try {
        const form = instance.form;
        if (!form) {
          console.log(`[cron/send-contract-timeout-notifications] Instance ${instance.id} has no linked form, skipping`);
          continue;
        }

        const contractSettings = form.contract_settings || {};
        
        if (!contractSettings.timeout_email_template_id) {
          continue;
        }

        const signers = instance.signers || [];
        const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
        const sentAt = instance.sent_at;

        if (!sentAt) {
          continue;
        }

        const sentDate = new Date(sentAt);
        const expiryDate = new Date(sentDate);
        expiryDate.setDate(expiryDate.getDate() + timeoutDays);

        if (now <= expiryDate) {
          continue;
        }

        const hasWinner = signers.some(s => s.status === 'received' || s.signed_at);
        if (hasWinner) {
          continue;
        }

        if (instance.timeout_notification_sent_at) {
          const lastNotification = new Date(instance.timeout_notification_sent_at);
          const hoursSinceNotification = (now - lastNotification) / (1000 * 60 * 60);
          if (hoursSinceNotification < 24) {
            continue;
          }
        }

        contractsExpired++;

        if (!instance.form_submission_id) {
          console.log(`[cron/send-contract-timeout-notifications] Instance ${instance.id} has no source submission, skipping notification`);
          continue;
        }

        const { data: sourceSubmission, error: submissionError } = await supabase
          .from('form_submission')
          .select('*, form:form_id(id, name, fields)')
          .eq('id', instance.form_submission_id)
          .single();

        if (submissionError || !sourceSubmission) {
          console.warn(`[cron/send-contract-timeout-notifications] Source submission ${instance.form_submission_id} not found`);
          continue;
        }

        const submissionData = sourceSubmission.submission_data || {};
        const applicantNameField = contractSettings.applicant_name_field;
        const applicantEmailField = contractSettings.applicant_email_field;

        if (!applicantEmailField) {
          console.log(`[cron/send-contract-timeout-notifications] No applicant email field configured for contract form ${form.id}`);
          continue;
        }

        const applicantEmail = submissionData[applicantEmailField];
        const applicantName = applicantNameField ? submissionData[applicantNameField] : 'Applicant';

        if (!applicantEmail) {
          console.log(`[cron/send-contract-timeout-notifications] No applicant email found in field ${applicantEmailField} for submission ${instance.form_submission_id}`);
          continue;
        }

        const { data: emailTemplate, error: templateError } = await supabase
          .from('email_template')
          .select('*')
          .eq('id', contractSettings.timeout_email_template_id)
          .single();

        if (templateError || !emailTemplate) {
          console.warn(`[cron/send-contract-timeout-notifications] Email template ${contractSettings.timeout_email_template_id} not found`);
          continue;
        }

        if (!tenantCache[form.tenant_id]) {
          const { data: tenant } = await supabase
            .from('tenant')
            .select('id, slug, name, contact_email, sender_email, sender_name')
            .eq('id', form.tenant_id)
            .single();
          tenantCache[form.tenant_id] = tenant;
        }
        const tenant = tenantCache[form.tenant_id];
        const tenantSlug = tenant?.slug || 'app';

        const currentRound = instance.timeout_notification_round || 0;
        const token = generateToken(instance.id, currentRound.toString(), tokenSecret);
        const alternativeSignerLink = `https://${tenantSlug}.iconn.app/embed/alternative-signer?contract=${instance.id}&token=${token}&tenant=${tenantSlug}&round=${currentRound}`;

        const placeholders = {
          applicant_name: applicantName,
          first_name: applicantName,
          contract_name: form.name,
          organization_name: instance.organization_id ? '' : '',
          alternative_signer_link: alternativeSignerLink,
          alternative_signer_url: alternativeSignerLink,
          tenant_name: tenant?.name || '',
          timeout_days: timeoutDays.toString()
        };

        if (instance.organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('name')
            .eq('id', instance.organization_id)
            .single();
          placeholders.organization_name = org?.name || '';
        }

        let emailBody = emailTemplate.body || '';
        let emailSubject = emailTemplate.subject || 'Contract Signing Timeout';

        for (const [key, value] of Object.entries(placeholders)) {
          const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
          emailBody = emailBody.replace(regex, value || '');
          emailSubject = emailSubject.replace(regex, value || '');
        }

        const senderEmail = tenant?.sender_email || tenant?.contact_email || 'noreply@iconn.app';
        const senderName = tenant?.sender_name || tenant?.name || 'Contracts';

        console.log(`[cron/send-contract-timeout-notifications] Sending timeout notification for instance ${instance.id} to ${applicantEmail}`);

        await sendEmail({
          to: applicantEmail,
          from: `${senderName} <${senderEmail}>`,
          subject: emailSubject,
          html: emailBody,
          tenantId: form.tenant_id
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
          console.warn(`[cron/send-contract-timeout-notifications] Failed to update instance ${instance.id}:`, updateError);
        }

        notificationsSent++;
        console.log(`[cron/send-contract-timeout-notifications] Sent timeout notification for instance ${instance.id}`);

      } catch (instanceError) {
        console.error(`[cron/send-contract-timeout-notifications] Error processing instance ${instance.id}:`, instanceError);
        contractsSkipped++;
      }
    }

    console.log(`[cron/send-contract-timeout-notifications] Complete: ${notificationsSent} notifications sent, ${contractsExpired} expired contracts found, ${contractsSkipped} skipped`);

    const endTime = Date.now();
    const durationMs = endTime - now.getTime();

    const tenantsSeen = [...new Set(contractInstances.filter(i => i.form?.tenant_id).map(i => i.form.tenant_id))];
    
    for (const tenantId of tenantsSeen) {
      const tenantInstances = contractInstances.filter(i => i.form?.tenant_id === tenantId);
      const tenantNotifications = tenantInstances.filter(i => i._notificationSent).length;
      
      await supabase.from('scheduled_task_log').insert({
        tenant_id: tenantId,
        task_name: 'contract_timeout_notifications',
        task_display_name: 'Contract Timeout Notifications',
        status: contractsSkipped > 0 ? 'partial' : (notificationsSent > 0 ? 'success' : 'no_action'),
        summary: notificationsSent > 0 
          ? `Sent ${notificationsSent} timeout notification${notificationsSent !== 1 ? 's' : ''}` 
          : 'No contracts required timeout notifications',
        details: {
          contracts_checked: contractInstances.length,
          notifications_sent: notificationsSent,
          contracts_expired: contractsExpired,
          contracts_skipped: contractsSkipped
        },
        items_processed: contractInstances.length,
        items_succeeded: notificationsSent,
        items_failed: contractsSkipped,
        duration_ms: durationMs
      });
    }

    if (tenantsSeen.length === 0) {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'contract_timeout_notifications',
        task_display_name: 'Contract Timeout Notifications',
        status: 'no_action',
        summary: 'No contracts to check',
        details: { contracts_checked: 0 },
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0,
        duration_ms: durationMs
      });
    }

    return res.status(200).json({
      message: 'Timeout notification check complete',
      notifications_sent: notificationsSent,
      contracts_expired: contractsExpired,
      contracts_skipped: contractsSkipped
    });

  } catch (error) {
    console.error('[cron/send-contract-timeout-notifications] Error:', error);
    
    try {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'contract_timeout_notifications',
        task_display_name: 'Contract Timeout Notifications',
        status: 'failed',
        summary: 'Task failed with error',
        error_message: error.message || 'Unknown error',
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0
      });
    } catch (logError) {
      console.error('[cron/send-contract-timeout-notifications] Failed to log error:', logError);
    }
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}
