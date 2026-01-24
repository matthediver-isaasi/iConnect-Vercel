import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenant_id = tenantUser.tenant_id;

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const pendingJobs = [];

    // Fetch contract instances for this tenant (no joins due to missing FK relationships)
    const { data: contractInstances, error: instancesError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('tenant_id', tenant_id)
      .in('status', ['out_for_signing', 'pending', 'expired']);

    if (instancesError) {
      if (instancesError.code === '42P01') {
        return res.status(200).json({ pending_jobs: [], summary: { timeouts: 0, reminders: 0 } });
      }
      console.error('[admin/pending-scheduled-jobs] Error:', instancesError);
      return res.status(500).json({ error: 'Failed to fetch contract instances' });
    }

    if (!contractInstances || contractInstances.length === 0) {
      return res.status(200).json({ 
        pending_jobs: [], 
        summary: { timeouts: 0, reminders: 0, will_send_next_run: 0 } 
      });
    }

    // Get unique form IDs and fetch forms
    const formIds = [...new Set(contractInstances.map(i => i.form_id).filter(Boolean))];
    const { data: forms } = await supabase
      .from('form')
      .select('id, name, slug, tenant_id, contract_settings')
      .eq('tenant_id', tenant_id)
      .in('id', formIds);

    const formsById = {};
    for (const form of (forms || [])) {
      formsById[form.id] = form;
    }

    // Get unique organization IDs and fetch organizations
    const orgIds = [...new Set(contractInstances.map(i => i.organization_id).filter(Boolean))];
    let orgsById = {};
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', orgIds);
      for (const org of (orgs || [])) {
        orgsById[org.id] = org;
      }
    }

    // Fetch all reminder logs for today to check which reminders were already sent
    const { data: todayReminders } = await supabase
      .from('contract_reminder_log')
      .select('reminder_key')
      .eq('tenant_id', tenant_id)
      .gte('sent_at', `${todayStr}T00:00:00.000Z`);

    const todayReminderKeys = new Set((todayReminders || []).map(r => r.reminder_key));

    // Fetch form submissions to determine which signers have signed
    const instanceIds = contractInstances.map(i => i.id);
    const { data: submissions } = await supabase
      .from('form_submission')
      .select('contract_instance_id, submission_data, submitted_by_email')
      .in('contract_instance_id', instanceIds);

    // Build a map of signed emails per contract instance
    const signedEmailsByInstance = {};
    for (const sub of (submissions || [])) {
      const instanceId = sub.contract_instance_id;
      if (!signedEmailsByInstance[instanceId]) {
        signedEmailsByInstance[instanceId] = new Set();
      }
      const data = sub.submission_data || sub.data;
      if (data) {
        const hasSignature = Object.values(data).some(v => 
          typeof v === 'object' && v?.type === 'signature'
        );
        if (hasSignature) {
          const email = data.signer_email || data.email || sub.submitted_by_email;
          if (email) signedEmailsByInstance[instanceId].add(email.toLowerCase());
        }
      }
    }

    for (const instance of contractInstances) {
      const form = formsById[instance.form_id];
      if (!form) continue;

      const org = orgsById[instance.organization_id];
      const contractSettings = form.contract_settings || {};
      const signers = instance.signers || [];
      const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
      const sentAt = instance.sent_at;

      if (!sentAt) continue;

      const sentDate = new Date(sentAt);
      const expiryDate = new Date(sentDate);
      expiryDate.setDate(expiryDate.getDate() + timeoutDays);

      const daysSinceSent = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));
      const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

      // Get signed emails for this instance (from form submissions)
      const signedEmails = signedEmailsByInstance[instance.id] || new Set();

      // Check for pending timeout notification (mirrors CRON logic exactly)
      if (now > expiryDate) {
        // Check if any signer has signed (matches CRON's hasWinner check)
        const hasWinner = signers.some(s => s.status === 'received' || s.signed_at);
        
        if (!hasWinner && contractSettings.timeout_email_template_id) {
          let willSend = true;
          let reason = 'Contract has expired without signature';
          
          // Check 24-hour cooldown (matches CRON logic)
          if (instance.timeout_notification_sent_at) {
            const lastNotification = new Date(instance.timeout_notification_sent_at);
            const hoursSinceNotification = (now - lastNotification) / (1000 * 60 * 60);
            if (hoursSinceNotification < 24) {
              willSend = false;
              reason = `Timeout notification sent ${Math.round(hoursSinceNotification)}h ago (24h cooldown)`;
            } else {
              reason = `Another timeout notification will be sent (${Math.round(hoursSinceNotification)}h since last)`;
            }
          }

          // Check if form_submission_id exists (required for notification)
          if (!instance.form_submission_id) {
            willSend = false;
            reason = 'No source submission linked (cannot send notification)';
          }

          // Calculate expected action date for timeout
          // Only compute if job is eligible (has form_submission_id)
          let expectedActionDate = null;
          if (instance.form_submission_id) {
            if (willSend) {
              expectedActionDate = now.toISOString(); // Will send on next CRON run
            } else if (instance.timeout_notification_sent_at) {
              // Next send will be 24h after last notification
              const nextSendDate = new Date(instance.timeout_notification_sent_at);
              nextSendDate.setHours(nextSendDate.getHours() + 24);
              expectedActionDate = nextSendDate.toISOString();
            }
          }

          pendingJobs.push({
            type: 'timeout',
            contract_id: instance.id,
            contract_name: form.name,
            organization_name: org?.name || null,
            signers: signers.map(s => ({
              name: s.first_name ? `${s.first_name} ${s.last_name || ''}`.trim() : s.name || s.email,
              email: s.email,
              signed: !!(s.status === 'received' || s.signed_at)
            })),
            expired_at: expiryDate.toISOString(),
            days_overdue: Math.abs(daysUntilExpiry),
            will_send_on_next_run: willSend,
            expected_action_date: expectedActionDate,
            reason,
            timeout_round: instance.timeout_notification_round || 0
          });
        }
      }

      // Check for pending reminders (only for out_for_signing contracts not yet expired)
      if (instance.status === 'out_for_signing' && now <= expiryDate) {
        const reminders = contractSettings.reminders || [];
        
        if (reminders.length === 0 || signers.length === 0) continue;

        // Find unsigned signers (using form_submission signatures like CRON does)
        const unsignedSigners = signers.filter(s => 
          !signedEmails.has((s.email || '').toLowerCase())
        );
        
        if (unsignedSigners.length === 0) continue;

        for (const reminder of reminders) {
          const reminderDays = reminder.days || reminder.days_before_timeout || 7;
          const timingType = reminder.timing_type || 'before_timeout';
          
          let willTrigger = false;
          let triggerReason = '';
          
          // Match CRON timing windows exactly
          if (timingType === 'before_timeout') {
            willTrigger = daysUntilExpiry <= reminderDays && daysUntilExpiry > (reminderDays - 1);
            triggerReason = willTrigger 
              ? `In window: ${reminderDays} days before timeout (${daysUntilExpiry} days remaining)`
              : daysUntilExpiry > reminderDays 
                ? `Scheduled: ${reminderDays} days before timeout (${daysUntilExpiry} days remaining)`
                : `Window passed: was ${reminderDays} days before timeout`;
          } else if (timingType === 'after_first_send') {
            willTrigger = daysSinceSent >= reminderDays && daysSinceSent < (reminderDays + 1);
            triggerReason = willTrigger
              ? `In window: ${reminderDays} days after send (${daysSinceSent} days elapsed)`
              : daysSinceSent < reminderDays
                ? `Scheduled: ${reminderDays} days after send (${daysSinceSent} days elapsed)`
                : `Window passed: was ${reminderDays} days after send`;
          }

          // Check if reminder was already sent today for any unsigned signer
          let allRemindersAlreadySent = true;
          const signersToRemind = [];
          
          for (const signer of unsignedSigners) {
            if (!signer.email) continue;
            const signerIdentifier = signer.id || signer.email;
            const reminderKey = `${instance.id}_${signerIdentifier}_${reminder.id}_${todayStr}`;
            
            if (!todayReminderKeys.has(reminderKey)) {
              allRemindersAlreadySent = false;
              signersToRemind.push(signer);
            }
          }

          if (willTrigger && allRemindersAlreadySent) {
            willTrigger = false;
            triggerReason = 'Already sent today to all unsigned signers';
          }

          // Calculate expected action date for reminder
          // Only compute if job is eligible (has email template and window not passed)
          let expectedActionDate = null;
          const hasEmailTemplate = !!reminder.email_template_id;
          const windowPassed = (timingType === 'before_timeout' && daysUntilExpiry <= (reminderDays - 1)) ||
                               (timingType === 'after_first_send' && daysSinceSent >= (reminderDays + 1));
          
          if (hasEmailTemplate && !windowPassed) {
            if (willTrigger) {
              expectedActionDate = now.toISOString(); // Will send on next CRON run
            } else if (timingType === 'before_timeout') {
              // Expected date is when daysUntilExpiry reaches reminderDays
              const triggerDate = new Date(expiryDate);
              triggerDate.setDate(triggerDate.getDate() - reminderDays);
              if (triggerDate > now) {
                expectedActionDate = triggerDate.toISOString();
              }
            } else if (timingType === 'after_first_send') {
              // Expected date is sentDate + reminderDays
              const triggerDate = new Date(sentDate);
              triggerDate.setDate(triggerDate.getDate() + reminderDays);
              if (triggerDate > now) {
                expectedActionDate = triggerDate.toISOString();
              }
            }
          }

          pendingJobs.push({
            type: 'reminder',
            contract_id: instance.id,
            contract_name: form.name,
            organization_name: org?.name || null,
            signers: (willTrigger ? signersToRemind : unsignedSigners).map(s => ({
              name: s.first_name ? `${s.first_name} ${s.last_name || ''}`.trim() : s.name || s.email,
              email: s.email,
              signed: false
            })),
            reminder_config: {
              timing_type: timingType,
              days: reminderDays,
              has_email_template: !!reminder.email_template_id
            },
            days_until_expiry: daysUntilExpiry,
            days_since_sent: daysSinceSent,
            will_send_on_next_run: willTrigger,
            expected_action_date: expectedActionDate,
            reason: triggerReason
          });
        }
      }
    }

    // Sort: items that will send on next run first, then by type
    pendingJobs.sort((a, b) => {
      if (a.will_send_on_next_run !== b.will_send_on_next_run) {
        return a.will_send_on_next_run ? -1 : 1;
      }
      if (a.type !== b.type) {
        return a.type === 'timeout' ? -1 : 1;
      }
      return 0;
    });

    const summary = {
      timeouts: pendingJobs.filter(j => j.type === 'timeout').length,
      reminders: pendingJobs.filter(j => j.type === 'reminder').length,
      will_send_next_run: pendingJobs.filter(j => j.will_send_on_next_run).length
    };

    return res.status(200).json({
      pending_jobs: pendingJobs,
      summary
    });

  } catch (error) {
    console.error('[admin/pending-scheduled-jobs] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
