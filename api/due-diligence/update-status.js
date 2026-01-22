import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { executeStageActions } from './_stageActions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { submissionId, newStatus, customMessage } = req.body;

    if (!submissionId || !newStatus) {
      return res.status(400).json({ error: 'submissionId and newStatus are required' });
    }

    // Get the due diligence submission record with tenant isolation
    const { data: ddSubmission, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('*, form_submission:form_submission_id(id, form_id)')
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (ddError || !ddSubmission) {
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    // Get the form's due diligence config with tenant isolation
    const { data: ddConfig, error: configError } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', ddSubmission.form_submission.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (configError || !ddConfig) {
      return res.status(404).json({ error: 'Due diligence config not found' });
    }

    const workflowStages = ddConfig.workflow_stages || [];
    const targetStage = workflowStages.find(s => s.id === newStatus);

    if (!targetStage) {
      return res.status(400).json({ error: `Invalid status: ${newStatus}` });
    }

    // Check selection conditions
    const conditionCheck = evaluateStageConditions(targetStage, ddSubmission);
    if (!conditionCheck.canSelect) {
      return res.status(400).json({ 
        error: 'Stage conditions not met',
        reasons: conditionCheck.reasons
      });
    }

    const previousStatus = ddSubmission.workflow_status;

    // Update the status with tenant isolation
    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update({
        workflow_status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[DD Status] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update status' });
    }

    // Add to history log
    await addHistoryLogEntry(submissionId, tenantCtx.tenantId, 'status_changed', member.email, {
      previous_status: previousStatus,
      new_status: newStatus,
      custom_message: customMessage || null
    });

    // Check for webhooks to trigger
    const webhooksTriggered = [];
    const statusWebhooks = ddConfig.status_change_webhooks || [];
    
    for (const webhook of statusWebhooks) {
      if (webhook.enabled !== false && webhook.trigger_status_id === newStatus) {
        try {
          await triggerWebhook(webhook, ddSubmission, ddConfig, customMessage, member.email);
          webhooksTriggered.push({
            id: webhook.id,
            name: webhook.name,
            success: true
          });
          
          // Update webhook reminder status
          await updateWebhookReminderStatus(submissionId, tenantCtx.tenantId, webhook.id, customMessage, member.email);
        } catch (webhookErr) {
          console.error(`[DD Webhook] Failed to trigger ${webhook.name}:`, webhookErr);
          webhooksTriggered.push({
            id: webhook.id,
            name: webhook.name,
            success: false,
            error: webhookErr.message
          });
        }
      }
    }

    // Execute stage actions (e.g., send contracts) using shared utility
    const actionResults = await executeStageActions(
      newStatus,
      ddSubmission,
      tenantCtx.tenantId,
      member.email
    );
    const stageActionsResults = actionResults.stage_actions_results || [];

    return res.status(200).json({
      success: true,
      previous_status: previousStatus,
      new_status: newStatus,
      webhooks_triggered: webhooksTriggered,
      stage_actions_results: stageActionsResults
    });

  } catch (error) {
    console.error('[DD Status] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function evaluateStageConditions(stage, submission) {
  if (!stage.selection_conditions) {
    return { canSelect: true, reasons: [] };
  }

  const conditions = stage.selection_conditions;
  const reasons = [];

  // Check signature requirement
  if (conditions.require_all_signatures) {
    const allAgreements = submission.agreements_status || [];
    const allSigned = allAgreements.length > 0 && allAgreements.every(ag => ag.is_signed === true);
    
    if (!allSigned) {
      const signedCount = allAgreements.filter(ag => ag.is_signed).length;
      reasons.push(`All signatures required (${signedCount}/${allAgreements.length} signed)`);
    }
  }

  // Check attachments requirement
  if (conditions.require_all_attachments_approved) {
    const allAttachments = submission.crm_attachments_status || [];
    const allApproved = allAttachments.length > 0 && allAttachments.every(att => att.is_approved === true);
    
    if (!allApproved) {
      const approvedCount = allAttachments.filter(att => att.is_approved).length;
      reasons.push(`All documents must be approved (${approvedCount}/${allAttachments.length} approved)`);
    }
  }

  // Check logo requirement
  if (conditions.require_logo_designated) {
    const hasLogoDesignated = submission.crm_attachments_status?.some(att => att.is_logo_attachment === true);
    
    if (!hasLogoDesignated) {
      reasons.push('Organization logo must be designated');
    }
  }

  // Check minimum score threshold
  if (conditions.min_score_threshold !== null && conditions.min_score_threshold !== undefined) {
    const currentScore = submission.due_diligence_score;
    
    if (currentScore === null || currentScore === undefined) {
      reasons.push(`Score must be calculated (minimum ${conditions.min_score_threshold}% required)`);
    } else if (currentScore < conditions.min_score_threshold) {
      reasons.push(`Score must be at least ${conditions.min_score_threshold}% (current: ${currentScore}%)`);
    }
  }

  // Check maximum score threshold
  if (conditions.max_score_threshold !== null && conditions.max_score_threshold !== undefined) {
    const currentScore = submission.due_diligence_score;
    
    if (currentScore !== null && currentScore !== undefined && currentScore > conditions.max_score_threshold) {
      reasons.push(`Score must be at most ${conditions.max_score_threshold}% (current: ${currentScore}%)`);
    }
  }

  return {
    canSelect: reasons.length === 0,
    reasons
  };
}

async function triggerWebhook(webhook, submission, config, customMessage, userEmail) {
  const webhookUrl = webhook.webhook_url;
  if (!webhookUrl) {
    throw new Error('No webhook URL configured');
  }

  let payload;

  if (webhook.payload_type === 'custom' && webhook.custom_payload_template) {
    payload = buildCustomPayload(webhook.custom_payload_template, submission, customMessage);
  } else {
    payload = {
      event: 'status_change',
      submission_id: submission.id,
      application_uid: submission.application_uid,
      workflow_status: submission.workflow_status,
      due_diligence_score: submission.due_diligence_score,
      risk_level: submission.risk_level,
      triggered_by: userEmail,
      timestamp: new Date().toISOString()
    };

    if (customMessage && webhook.custom_message_payload_key) {
      payload[webhook.custom_message_payload_key] = customMessage;
    }
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }

  return true;
}

function buildCustomPayload(template, submission, customMessage) {
  let payload = template;

  const replacements = {
    '{{submission.id}}': submission.id,
    '{{submission.application_uid}}': submission.application_uid || '',
    '{{submission.workflow_status}}': submission.workflow_status || '',
    '{{submission.due_diligence_score}}': submission.due_diligence_score || 0,
    '{{submission.risk_level}}': submission.risk_level || '',
    '{{custom_message}}': customMessage || '',
    '{{timestamp}}': new Date().toISOString()
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    payload = payload.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
  }

  try {
    return JSON.parse(payload);
  } catch {
    return { raw: payload };
  }
}

async function updateWebhookReminderStatus(submissionId, tenantId, webhookId, customMessage, userEmail) {
  try {
    const { data: submission } = await supabase
      .from('form_submission_due_diligence')
      .select('status_webhook_reminders_status, sent_webhook_messages')
      .eq('id', submissionId)
      .eq('tenant_id', tenantId)
      .single();

    const reminderStatus = submission?.status_webhook_reminders_status || [];
    const sentMessages = submission?.sent_webhook_messages || [];

    // Update reminder status
    const existingIndex = reminderStatus.findIndex(r => r.webhook_id === webhookId);
    const now = new Date().toISOString();
    
    if (existingIndex >= 0) {
      reminderStatus[existingIndex].last_triggered_date = now;
      reminderStatus[existingIndex].reminder_count = (reminderStatus[existingIndex].reminder_count || 0) + 1;
    } else {
      reminderStatus.push({
        webhook_id: webhookId,
        last_triggered_date: now,
        reminder_count: 0
      });
    }

    // Log sent message if custom message was provided
    if (customMessage) {
      sentMessages.push({
        webhook_id: webhookId,
        message: customMessage,
        timestamp: now,
        sent_by: userEmail
      });
    }

    await supabase
      .from('form_submission_due_diligence')
      .update({
        status_webhook_reminders_status: reminderStatus,
        sent_webhook_messages: sentMessages
      })
      .eq('id', submissionId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[DD Webhook] Failed to update reminder status:', err);
  }
}

async function addHistoryLogEntry(submissionId, tenantId, eventType, userEmail, details) {
  try {
    const { data: submission } = await supabase
      .from('form_submission_due_diligence')
      .select('history_log')
      .eq('id', submissionId)
      .eq('tenant_id', tenantId)
      .single();

    const historyLog = submission?.history_log || [];
    historyLog.push({
      timestamp: new Date().toISOString(),
      event_type: eventType,
      user_email: userEmail,
      details
    });

    await supabase
      .from('form_submission_due_diligence')
      .update({ history_log: historyLog })
      .eq('id', submissionId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[DD History] Failed to add log entry:', err);
  }
}

