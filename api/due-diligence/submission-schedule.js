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

    // Fetch ALL contract instances linked to this form submission
    // Contracts are linked via form_submission_id on contract_instance table
    const { data: contractInstances, error: contractsError } = await supabase
      .from('contract_instance')
      .select('id')
      .eq('form_submission_id', form_submission_id)
      .eq('tenant_id', tenantId);

    if (contractsError) {
      console.error('[submission-schedule] Contract instances query error:', contractsError);
    }

    console.log('[submission-schedule] Found contract instances:', {
      formSubmissionId: form_submission_id,
      contractCount: contractInstances?.length || 0,
      contractIds: (contractInstances || []).map(c => c.id)
    });

    // Fetch contract-related scheduled events for ALL contracts
    if (contractInstances && contractInstances.length > 0) {
      for (const contractInstance of contractInstances) {
        console.log('[submission-schedule] Processing contract instance:', contractInstance.id);
        const { events: contractSchedule, metadata } = await getContractSchedule(
          supabase, 
          tenantId, 
          contractInstance.id, 
          now, 
          todayStr
        );
        console.log('[submission-schedule] Contract schedule events:', contractSchedule.length, 'metadata:', metadata);
        scheduledEvents.push(...contractSchedule);
        
        // If no contract events but we expected some, add an info event for this specific contract
        if (contractSchedule.length === 0 && metadata) {
          if (metadata.noRemindersConfigured) {
            scheduledEvents.push({
              type: 'info',
              name: 'No Reminders Configured',
              status: 'info',
              status_reason: `No contract reminders configured for contract ${contractInstance.id}`,
              scheduled_date: null,
              contract: { id: contractInstance.id }
            });
          }
          if (metadata.noSigners) {
            scheduledEvents.push({
              type: 'info', 
              name: 'No Signers',
              status: 'info',
              status_reason: `No signers configured for contract ${contractInstance.id}`,
              scheduled_date: null,
              contract: { id: contractInstance.id }
            });
          }
        }
      }
    } else {
      console.log('[submission-schedule] No contract instances linked to submission');
      scheduledEvents.push({
        type: 'info',
        name: 'No Contract Created',
        status: 'info',
        status_reason: 'No contracts have been created for this submission yet',
        scheduled_date: null
      });
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
  const metadata = {
    noRemindersConfigured: false,
    noSigners: false
  };

  // Fetch the contract instance
  const { data: instance, error: instanceError } = await supabase
    .from('contract_instance')
    .select('*')
    .eq('id', contractInstanceId)
    .eq('tenant_id', tenantId)
    .single();

  if (instanceError || !instance) {
    console.log('[submission-schedule] No contract instance found:', { contractInstanceId, instanceError });
    return { events, metadata };
  }

  // Fetch the contract form for contract settings
  const { data: form, error: formError } = await supabase
    .from('form')
    .select('id, name, contract_settings')
    .eq('id', instance.form_id)
    .single();

  if (formError || !form) {
    console.log('[submission-schedule] No form found:', { formId: instance.form_id, formError });
    return { events, metadata };
  }

  // Fetch the contact field label from the source form (application form)
  // The source_contact_field_id points to a field in the application form
  let contactFieldLabel = null;
  if (instance.source_contact_field_id && instance.form_submission_id) {
    // Get the form submission to find the source form
    const { data: formSubmission } = await supabase
      .from('form_submission')
      .select('form_id')
      .eq('id', instance.form_submission_id)
      .single();
    
    if (formSubmission?.form_id) {
      const { data: sourceForm } = await supabase
        .from('form')
        .select('fields')
        .eq('id', formSubmission.form_id)
        .single();
      
      if (sourceForm?.fields) {
        const contactField = sourceForm.fields.find(f => 
          f.id === instance.source_contact_field_id || 
          f.name === instance.source_contact_field_id
        );
        contactFieldLabel = contactField?.label || contactField?.name || null;
      }
    }
  }

  const contractSettings = form.contract_settings || {};
  const reminders = contractSettings.reminders || [];
  const signers = instance.signers || [];
  const timeoutDays = instance.timeout_days || contractSettings.timeout_days || 30;
  const sentAt = instance.sent_at;

  // Track metadata for empty cases
  if (reminders.length === 0) {
    metadata.noRemindersConfigured = true;
  }
  if (signers.length === 0) {
    metadata.noSigners = true;
  }

  console.log('[submission-schedule] Contract schedule data:', {
    contractInstanceId,
    formId: form.id,
    formName: form.name,
    reminderCount: reminders.length,
    signerCount: signers.length,
    sentAt,
    timeoutDays,
    contractSettings: JSON.stringify(contractSettings).substring(0, 500)
  });

  // If contract not sent yet, show projected schedule based on configuration
  if (!sentAt) {
    console.log('[submission-schedule] Contract not sent yet, showing projected schedule');
    
    // Show projected reminders based on what WOULD happen when sent
    for (const reminder of reminders) {
      const reminderDays = reminder.days || reminder.days_before_timeout || 7;
      const timingType = reminder.timing_type || 'before_timeout';
      const reminderName = reminder.name || `Reminder (${reminderDays} days ${timingType === 'before_timeout' ? 'before timeout' : 'after send'})`;
      
      for (const signer of signers) {
        if (!signer.email) continue;
        const signerName = signer.first_name ? `${signer.first_name} ${signer.last_name || ''}`.trim() : signer.name || signer.email;
        
        events.push({
          type: 'contract_reminder',
          name: reminderName,
          scheduled_date: null, // Unknown until contract is sent
          actual_sent_date: null,
          status: 'awaiting_send',
          status_reason: 'Contract has not been sent yet',
          recipient: {
            name: signerName,
            email: signer.email,
            title: contactFieldLabel
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
    
    // Show projected timeout notification
    if (contractSettings.timeout_email_template_id) {
      events.push({
        type: 'contract_timeout',
        name: 'Contract Timeout Notification',
        scheduled_date: null,
        actual_sent_date: null,
        status: 'awaiting_send',
        status_reason: 'Contract has not been sent yet',
        contract: {
          id: instance.id,
          name: form.name
        }
      });
    }
    
    return { events, metadata };
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

  console.log('[submission-schedule] Processing reminders:', {
    reminderCount: reminders.length,
    unsignedSignerCount: unsignedSigners.length,
    signedSignerCount: signers.length - unsignedSigners.length,
    reminderDetails: reminders.map(r => ({ id: r.id, name: r.name, days: r.days || r.days_before_timeout, timingType: r.timing_type }))
  });

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
          email: signer.email,
          title: contactFieldLabel
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
          email: signer.email,
          title: contactFieldLabel
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
      },
      contact_title: contactFieldLabel
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
      },
      contact_title: contactFieldLabel
    });
  }

  return { events, metadata };
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
