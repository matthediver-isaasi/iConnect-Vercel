import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantContext.tenantId;
  const { form_submission_id } = req.query;

  if (!form_submission_id) {
    return res.status(400).json({ error: 'form_submission_id is required' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const scheduledEvents = [];

    // Get the form submission to find contract_instance_id
    const { data: formSubmission, error: fsError } = await supabase
      .from('form_submission')
      .select('id, contract_instance_id')
      .eq('id', form_submission_id)
      .eq('tenant_id', tenantId)
      .single();

    if (fsError) {
      console.error('[submission-schedule] Form submission error:', fsError);
      return res.status(404).json({ error: 'Form submission not found' });
    }

    // Fetch contract-related scheduled events if there's a contract instance
    if (formSubmission.contract_instance_id) {
      const contractSchedule = await getContractSchedule(
        supabase, 
        tenantId, 
        formSubmission.contract_instance_id, 
        now, 
        todayStr
      );
      scheduledEvents.push(...contractSchedule);
    }

    // Fetch meeting request schedule
    const meetingSchedule = await getMeetingRequestSchedule(
      supabase,
      tenantId,
      form_submission_id
    );
    scheduledEvents.push(...meetingSchedule);

    // Sort by scheduled date
    scheduledEvents.sort((a, b) => {
      const dateA = a.scheduled_date ? new Date(a.scheduled_date) : new Date(0);
      const dateB = b.scheduled_date ? new Date(b.scheduled_date) : new Date(0);
      return dateA - dateB;
    });

    return res.status(200).json({ 
      scheduled_events: scheduledEvents,
      generated_at: now.toISOString()
    });

  } catch (error) {
    console.error('[submission-schedule] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getContractSchedule(supabase, tenantId, contractInstanceId, now, todayStr) {
  const events = [];

  // Fetch the contract instance
  const { data: instance, error: instanceError } = await supabase
    .from('contract_instance')
    .select('*')
    .eq('id', contractInstanceId)
    .eq('tenant_id', tenantId)
    .single();

  if (instanceError || !instance) {
    return events;
  }

  // Fetch the form for contract settings
  const { data: form, error: formError } = await supabase
    .from('form')
    .select('id, name, contract_settings')
    .eq('id', instance.form_id)
    .single();

  if (formError || !form) {
    return events;
  }

  const contractSettings = form.contract_settings || {};
  const reminders = contractSettings.reminders || [];
  const signers = instance.signers || [];
  const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
  const sentAt = instance.sent_at;

  if (!sentAt) {
    return events;
  }

  const sentDate = new Date(sentAt);
  const expiryDate = new Date(sentDate);
  expiryDate.setDate(expiryDate.getDate() + timeoutDays);

  const daysSinceSent = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  // Get signed emails from form submissions
  const { data: submissions } = await supabase
    .from('form_submission')
    .select('submission_data, submitted_by_email')
    .eq('contract_instance_id', contractInstanceId);

  const signedEmails = new Set();
  for (const sub of (submissions || [])) {
    const data = sub.submission_data || sub.data;
    if (data) {
      const email = data.signer_email || data.email || sub.submitted_by_email;
      if (email) signedEmails.add(email.toLowerCase());
    }
  }

  // Fetch ALL reminder logs for this contract to determine what was sent
  const { data: reminderLogs } = await supabase
    .from('contract_reminder_log')
    .select('reminder_key, sent_at, signer_email')
    .eq('contract_instance_id', contractInstanceId)
    .eq('tenant_id', tenantId);

  // Build lookup of sent reminder keys (exact keys as CRON generates them)
  // Key format: instance_id_signerIdentifier_reminderId_dateStr
  const sentReminderKeys = new Set((reminderLogs || []).map(r => r.reminder_key));
  // Also build a map to get sent_at for sent reminders
  const reminderLogByKey = new Map();
  for (const log of (reminderLogs || [])) {
    reminderLogByKey.set(log.reminder_key, log);
  }

  // Build list of unsigned signers (as CRON does)
  const unsignedSigners = signers.filter(s => 
    s.email && !signedEmails.has((s.email || '').toLowerCase())
  );

  // Contract is actively awaiting signatures if out_for_signing and not expired
  const isActiveContract = instance.status === 'out_for_signing' && now <= expiryDate;
  const contractComplete = instance.status === 'signed' || instance.status === 'cancelled' || instance.status === 'expired';
  // Check if any signer has completed - used for timeout logic only
  const hasWinner = signers.some(s => s.status === 'received' || s.signed_at);

  // Generate reminder events - mirror CRON logic exactly
  // CRON iterates reminders, then unsigned signers only
  for (const reminder of reminders) {
    const reminderDays = reminder.days || reminder.days_before_timeout || 7;
    const timingType = reminder.timing_type || 'before_timeout';
    const reminderName = reminder.name || `Reminder (${reminderDays} days ${timingType === 'before_timeout' ? 'before timeout' : 'after send'})`;

    // Calculate scheduled date (the day the reminder window opens)
    let scheduledDate;
    if (timingType === 'before_timeout') {
      scheduledDate = new Date(expiryDate);
      scheduledDate.setDate(scheduledDate.getDate() - reminderDays);
    } else {
      scheduledDate = new Date(sentDate);
      scheduledDate.setDate(scheduledDate.getDate() + reminderDays);
    }
    const scheduledDateStr = scheduledDate.toISOString().split('T')[0];

    // Calculate if we're in the window (CRON only sends during the window day)
    let isInWindow = false;
    if (timingType === 'before_timeout') {
      isInWindow = daysUntilExpiry <= reminderDays && daysUntilExpiry > (reminderDays - 1);
    } else {
      isInWindow = daysSinceSent >= reminderDays && daysSinceSent < (reminderDays + 1);
    }

    const windowPassed = scheduledDate < now && !isInWindow;

    // Process unsigned signers (what CRON would process)
    for (const signer of unsignedSigners) {
      const signerIdentifier = signer.id || signer.email;
      const signerName = signer.first_name ? `${signer.first_name} ${signer.last_name || ''}`.trim() : signer.name || signer.email;

      // Check if reminder was sent on the scheduled date (exact key match like CRON)
      const reminderKey = `${contractInstanceId}_${signerIdentifier}_${reminder.id}_${scheduledDateStr}`;
      const sentLog = reminderLogByKey.get(reminderKey);
      const wasSent = !!sentLog;

      let status;
      let statusReason;

      // Priority 1: Already sent on the scheduled date
      if (wasSent) {
        status = 'sent';
        statusReason = null;
      }
      // Priority 2: Contract is no longer active (CRON only processes active contracts)
      else if (!isActiveContract) {
        if (instance.status !== 'out_for_signing') {
          status = 'cancelled';
          statusReason = `Contract status: ${instance.status}`;
        } else if (now > expiryDate) {
          status = 'cancelled';
          statusReason = 'Contract has expired';
        } else {
          status = 'cancelled';
          statusReason = 'Contract is not active';
        }
      }
      // Priority 3: Window passed without sending
      else if (windowPassed) {
        status = 'missed';
        statusReason = 'Reminder window passed without sending';
      }
      // Priority 4: Currently in window - will send on next CRON run
      else if (isInWindow) {
        status = 'pending';
        statusReason = 'Will be sent on next CRON run';
      }
      // Priority 5: Scheduled for future
      else if (scheduledDate > now) {
        status = 'scheduled';
        statusReason = null;
      }
      // Fallback
      else {
        status = 'missed';
        statusReason = 'Window passed';
      }

      events.push({
        type: 'contract_reminder',
        name: reminderName,
        scheduled_date: scheduledDate.toISOString(),
        actual_sent_date: sentLog?.sent_at || null,
        status,
        status_reason: statusReason,
        recipient: {
          name: signerName,
          email: signer.email
        },
        contract: {
          id: instance.id,
          name: form.name
        },
        reminder_config: {
          id: reminder.id,
          timing_type: timingType,
          days: reminderDays
        }
      });
    }

    // Also show cancelled entries for signed signers (for UI clarity)
    const signedSigners = signers.filter(s => 
      s.email && signedEmails.has((s.email || '').toLowerCase())
    );
    for (const signer of signedSigners) {
      const signerName = signer.first_name ? `${signer.first_name} ${signer.last_name || ''}`.trim() : signer.name || signer.email;
      
      // Check if reminder was sent before they signed
      const signerIdentifier = signer.id || signer.email;
      const reminderKey = `${contractInstanceId}_${signerIdentifier}_${reminder.id}_${scheduledDateStr}`;
      const sentLog = reminderLogByKey.get(reminderKey);

      events.push({
        type: 'contract_reminder',
        name: reminderName,
        scheduled_date: scheduledDate.toISOString(),
        actual_sent_date: sentLog?.sent_at || null,
        status: sentLog ? 'sent' : 'cancelled',
        status_reason: sentLog ? null : 'Signer has signed the contract',
        recipient: {
          name: signerName,
          email: signer.email
        },
        contract: {
          id: instance.id,
          name: form.name
        },
        reminder_config: {
          id: reminder.id,
          timing_type: timingType,
          days: reminderDays
        }
      });
    }
  }

  // Add timeout notification event - mirror CRON logic exactly
  if (contractSettings.timeout_email_template_id && instance.form_submission_id) {
    let status;
    let statusReason;
    let actualSentDate = null;

    if (hasWinner) {
      status = 'cancelled';
      statusReason = 'Contract was signed';
    } else if (contractComplete) {
      status = 'cancelled';
      statusReason = `Contract ${instance.status}`;
    } else if (now > expiryDate) {
      // Contract is expired - check if timeout was sent
      if (instance.timeout_notification_sent_at) {
        status = 'sent';
        actualSentDate = instance.timeout_notification_sent_at;
        statusReason = null;
        
        // Check 24h cooldown for potential next send
        const lastNotification = new Date(instance.timeout_notification_sent_at);
        const hoursSinceNotification = (now - lastNotification) / (1000 * 60 * 60);
        if (hoursSinceNotification >= 24) {
          // Another notification could be pending
          statusReason = 'Another timeout notification may be pending (24h since last)';
        }
      } else {
        status = 'pending';
        statusReason = 'Will be sent on next CRON run';
      }
    } else {
      status = 'scheduled';
      statusReason = null;
    }

    events.push({
      type: 'contract_timeout',
      name: 'Contract Timeout Notification',
      scheduled_date: expiryDate.toISOString(),
      actual_sent_date: actualSentDate,
      status,
      status_reason: statusReason,
      contract: {
        id: instance.id,
        name: form.name
      }
    });
  } else if (!contractSettings.timeout_email_template_id && !contractComplete) {
    // No timeout template configured
    events.push({
      type: 'contract_timeout',
      name: 'Contract Timeout Notification',
      scheduled_date: expiryDate.toISOString(),
      actual_sent_date: null,
      status: 'cancelled',
      status_reason: 'No timeout email template configured',
      contract: {
        id: instance.id,
        name: form.name
      }
    });
  }

  return events;
}

async function getMeetingRequestSchedule(supabase, tenantId, formSubmissionId) {
  const events = [];

  // Fetch meeting requests for this submission
  const { data: meetingRequests, error } = await supabase
    .from('dd_meeting_request')
    .select(`
      *,
      meeting_template:meeting_template_id (
        id, name, slug, duration_minutes
      ),
      agent:agent_identity_id (
        id, first_name, last_name, email
      ),
      booking:agent_booking_id (
        id, starts_at, ends_at, status
      )
    `)
    .eq('form_submission_id', formSubmissionId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[submission-schedule] Meeting requests error:', error);
    return events;
  }

  for (const mr of (meetingRequests || [])) {
    const agentName = mr.agent ? 
      `${mr.agent.first_name || ''} ${mr.agent.last_name || ''}`.trim() || mr.agent.email 
      : 'Unknown agent';

    // Determine status based on actual meeting request status
    let status;
    let statusReason;
    let eventDate = mr.sent_at || mr.created_at;

    if (mr.status === 'booked' || mr.booking) {
      status = 'completed';
      statusReason = 'Meeting was booked';
      if (mr.booking?.starts_at) {
        eventDate = mr.booking.starts_at;
      }
    } else if (mr.status === 'cancelled') {
      status = 'cancelled';
      statusReason = mr.cancel_reason || 'Request was cancelled';
    } else if (mr.status === 'expired') {
      status = 'cancelled';
      statusReason = 'Request expired without booking';
    } else {
      status = 'pending';
      statusReason = 'Awaiting booking from recipient';
    }

    events.push({
      type: 'meeting_request',
      name: mr.meeting_template?.name || 'Meeting Request',
      scheduled_date: eventDate,
      status,
      status_reason: statusReason,
      recipient: {
        name: mr.recipient_name,
        email: mr.recipient_email
      },
      agent: {
        name: agentName,
        email: mr.agent?.email
      },
      meeting: mr.booking ? {
        starts_at: mr.booking.starts_at,
        ends_at: mr.booking.ends_at,
        status: mr.booking.status
      } : null
    });
  }

  return events;
}
