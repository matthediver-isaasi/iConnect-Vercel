import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';

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

    // Execute stage actions (e.g., send contracts)
    const stageActionsResults = [];
    const stageActions = targetStage.stage_actions || {};
    
    if (stageActions.send_contracts && stageActions.send_contracts.length > 0) {
      const contractResults = await executeContractSendingActions(
        stageActions.send_contracts,
        ddSubmission,
        tenantCtx.tenantId,
        member.email
      );
      stageActionsResults.push(...contractResults);
    }

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

// Execute contract sending actions for stage transitions
async function executeContractSendingActions(contactFieldIds, ddSubmission, tenantId, triggeredBy) {
  const results = [];
  
  if (!contactFieldIds || contactFieldIds.length === 0) {
    return results;
  }

  const formSubmissionId = ddSubmission.form_submission_id;
  if (!formSubmissionId) {
    console.log('[DD Stage Actions] No form submission ID, skipping contract sending');
    return results;
  }

  try {
    // Get the source form to find contact field configurations
    const { data: sourceForm, error: formError } = await supabase
      .from('form')
      .select('id, fields')
      .eq('id', ddSubmission.form_submission?.form_id)
      .single();

    if (formError || !sourceForm) {
      console.error('[DD Stage Actions] Could not find source form:', formError);
      return results;
    }

    // Get tenant info for base URL
    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = process.env.APP_URL || `https://${tenant?.slug || 'app'}.iconn.app`;

    // Get contract instances linked to this form submission
    const { data: contractInstances, error: instancesError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantId);

    if (instancesError) {
      console.error('[DD Stage Actions] Error fetching contract instances:', instancesError);
      return results;
    }

    // Process each contact field ID that should trigger contract sending
    for (const fieldId of contactFieldIds) {
      const field = (sourceForm.fields || []).find(f => f.id === fieldId || f.name === fieldId);
      
      if (!field || field.type !== 'contact' || !field.contract_form_id) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          status: 'skipped',
          reason: 'Field not found or not a contract contact field'
        });
        continue;
      }

      // Find contract instance for this field by matching contract form ID
      // Primary match: by source_contact_field_id (for new instances that have this set)
      let contractInstance = contractInstances?.find(
        ci => ci.source_contact_field_id === fieldId && ci.form_id === field.contract_form_id
      );

      // Fallback: match by form_id for instances without source_contact_field_id
      // This handles legacy instances before the column was added
      // Only match if: same form_id AND not already sent AND no source_contact_field_id set
      if (!contractInstance) {
        const candidateInstances = (contractInstances || []).filter(
          ci => ci.form_id === field.contract_form_id && !ci.sent_at && !ci.source_contact_field_id
        );
        // If exactly one candidate, use it; otherwise skip to avoid mis-association
        if (candidateInstances.length === 1) {
          contractInstance = candidateInstances[0];
        } else if (candidateInstances.length > 1) {
          // Ambiguous match - cannot determine which instance belongs to this field
          results.push({
            action: 'send_contract',
            field_id: fieldId,
            field_label: field.label || field.name,
            status: 'skipped',
            reason: 'Multiple matching contract instances found - unable to determine correct one'
          });
          continue;
        }
      }

      if (!contractInstance) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          status: 'skipped',
          reason: 'No contract instance found for this field'
        });
        continue;
      }

      // Check if already sent
      if (contractInstance.sent_at) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'skipped',
          reason: 'Contract already sent'
        });
        continue;
      }

      // Get the contract form to find initial email template
      const { data: contractForm, error: contractFormError } = await supabase
        .from('form')
        .select('id, name, slug, contract_settings')
        .eq('id', field.contract_form_id)
        .single();

      if (contractFormError || !contractForm) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'failed',
          reason: 'Contract form not found'
        });
        continue;
      }

      const initialTemplateId = contractForm.contract_settings?.initial_email_template_id;
      
      if (!initialTemplateId) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'skipped',
          reason: 'No initial email template configured for contract form'
        });
        continue;
      }

      // Get the email template
      const { data: emailTemplate, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', initialTemplateId)
        .eq('tenant_id', tenantId)
        .single();

      if (templateError || !emailTemplate) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'failed',
          reason: 'Email template not found'
        });
        continue;
      }

      // Send emails to each signer
      const signers = contractInstance.signers || [];
      let sentCount = 0;
      let failedCount = 0;

      for (const signer of signers) {
        if (!signer.email) {
          failedCount++;
          continue;
        }

        const signingUrl = `${baseUrl}/form/${contractForm.slug}?contract_instance=${contractInstance.id}&signer=${encodeURIComponent(signer.email)}`;

        let subject = emailTemplate.subject || 'Contract for Signing';
        let body = emailTemplate.body || '';

        // Replace placeholders
        subject = subject
          .replace(/\{\{signer_name\}\}/gi, signer.name || '')
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        body = body
          .replace(/\{\{signer_name\}\}/gi, signer.name || '')
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        try {
          await sendEmail({
            to: signer.email,
            subject,
            html: body,
            from: emailTemplate.from_email,
            replyTo: emailTemplate.reply_to,
            tenantId
          });
          sentCount++;
          console.log(`[DD Stage Actions] Sent contract to ${signer.email}`);
        } catch (emailError) {
          failedCount++;
          console.error(`[DD Stage Actions] Failed to send to ${signer.email}:`, emailError);
        }
      }

      // Update contract instance to mark as sent
      if (sentCount > 0) {
        await supabase
          .from('contract_instance')
          .update({
            sent_at: new Date().toISOString(),
            status: 'out_for_signing',
            updated_at: new Date().toISOString()
          })
          .eq('id', contractInstance.id)
          .eq('tenant_id', tenantId);
      }

      results.push({
        action: 'send_contract',
        field_id: fieldId,
        field_label: field.label || field.name,
        contract_instance_id: contractInstance.id,
        status: sentCount > 0 ? 'success' : 'failed',
        sent_count: sentCount,
        failed_count: failedCount
      });
    }
  } catch (error) {
    console.error('[DD Stage Actions] Error executing contract sending:', error);
    results.push({
      action: 'send_contract',
      status: 'error',
      error: error.message
    });
  }

  return results;
}
