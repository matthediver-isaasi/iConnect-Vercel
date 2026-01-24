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
    const pendingJobs = [];

    // Fetch contract instances for this tenant
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
        ),
        organization:organization_id (
          id,
          name
        )
      `)
      .in('status', ['out_for_signing', 'pending', 'expired']);

    if (instancesError) {
      if (instancesError.code === '42P01') {
        return res.status(200).json({ pending_jobs: [], summary: { timeouts: 0, reminders: 0 } });
      }
      console.error('[admin/pending-scheduled-jobs] Error:', instancesError);
      return res.status(500).json({ error: 'Failed to fetch contract instances' });
    }

    // Filter to this tenant's contracts
    const tenantContracts = (contractInstances || []).filter(
      instance => instance.form?.tenant_id === tenant_id
    );

    for (const instance of tenantContracts) {
      const form = instance.form;
      if (!form) continue;

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

      // Check for pending timeout notification
      if (now > expiryDate) {
        const hasWinner = signers.some(s => s.status === 'received' || s.signed_at);
        
        if (!hasWinner && contractSettings.timeout_email_template_id) {
          let willSend = true;
          let reason = 'Contract has expired without signature';
          
          if (instance.timeout_notification_sent_at) {
            const lastNotification = new Date(instance.timeout_notification_sent_at);
            const hoursSinceNotification = (now - lastNotification) / (1000 * 60 * 60);
            if (hoursSinceNotification < 24) {
              willSend = false;
              reason = `Timeout notification already sent ${Math.round(hoursSinceNotification)} hours ago (waiting 24h)`;
            } else {
              reason = `Will send another timeout notification (${Math.round(hoursSinceNotification)}h since last)`;
            }
          }

          pendingJobs.push({
            type: 'timeout',
            contract_id: instance.id,
            contract_name: form.name,
            organization_name: instance.organization?.name || null,
            signers: signers.map(s => ({
              name: s.first_name ? `${s.first_name} ${s.last_name || ''}`.trim() : s.name || s.email,
              email: s.email,
              signed: !!(s.status === 'received' || s.signed_at)
            })),
            expired_at: expiryDate.toISOString(),
            days_overdue: Math.abs(daysUntilExpiry),
            will_send_on_next_run: willSend,
            reason,
            timeout_round: instance.timeout_notification_round || 0
          });
        }
      }

      // Check for pending reminders (only for out_for_signing contracts not yet expired)
      if (instance.status === 'out_for_signing' && now <= expiryDate) {
        const reminders = contractSettings.reminders || [];
        
        // Find unsigned signers
        const unsignedSigners = signers.filter(s => !(s.status === 'received' || s.signed_at));
        
        if (unsignedSigners.length > 0 && reminders.length > 0) {
          for (const reminder of reminders) {
            const reminderDays = reminder.days || reminder.days_before_timeout || 7;
            const timingType = reminder.timing_type || 'before_timeout';
            
            let willTrigger = false;
            let triggerDate = null;
            let triggerReason = '';
            
            if (timingType === 'before_timeout') {
              // Reminder triggers X days before timeout
              triggerDate = new Date(expiryDate);
              triggerDate.setDate(triggerDate.getDate() - reminderDays);
              willTrigger = daysUntilExpiry <= reminderDays && daysUntilExpiry > 0;
              triggerReason = willTrigger 
                ? `Triggers ${reminderDays} days before timeout (${daysUntilExpiry} days remaining)`
                : `Scheduled for ${reminderDays} days before timeout`;
            } else if (timingType === 'after_first_send') {
              // Reminder triggers X days after first send
              triggerDate = new Date(sentDate);
              triggerDate.setDate(triggerDate.getDate() + reminderDays);
              willTrigger = daysSinceSent >= reminderDays;
              triggerReason = willTrigger
                ? `Triggers ${reminderDays} days after send (${daysSinceSent} days elapsed)`
                : `Scheduled for ${reminderDays} days after send`;
            }

            pendingJobs.push({
              type: 'reminder',
              contract_id: instance.id,
              contract_name: form.name,
              organization_name: instance.organization?.name || null,
              signers: unsignedSigners.map(s => ({
                name: s.first_name ? `${s.first_name} ${s.last_name || ''}`.trim() : s.name || s.email,
                email: s.email,
                signed: false
              })),
              reminder_config: {
                timing_type: timingType,
                days: reminderDays,
                has_email_template: !!reminder.email_template_id
              },
              trigger_date: triggerDate?.toISOString(),
              days_until_expiry: daysUntilExpiry,
              days_since_sent: daysSinceSent,
              will_send_on_next_run: willTrigger,
              reason: triggerReason
            });
          }
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
