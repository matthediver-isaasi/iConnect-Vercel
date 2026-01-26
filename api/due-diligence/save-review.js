import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
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
    const {
      submissionId,
      reviewedFormValues,
      fieldReviewStatus,
      fieldNotes,
      staticQuestionResponses,
      staticQuestionNotes,
      notes
      // NOTE: workflowStatus is NOT accepted here - use update-status endpoint for status changes
    } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    // Get current submission state with tenant isolation
    const { data: ddSubmission, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('*, form_submission:form_submission_id(id, form_id)')
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (ddError || !ddSubmission) {
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    // Check if this is the first edit (reviewed_by was previously null)
    const isFirstEdit = !ddSubmission.reviewed_by;
    console.log(`[DD Review] First edit check: reviewed_by=${ddSubmission.reviewed_by}, isFirstEdit=${isFirstEdit}, first_edit_triggered=${ddSubmission.first_edit_triggered}`);

    const updateData = {
      updated_at: new Date().toISOString(),
      reviewed_by: member.email,
      reviewed_date: new Date().toISOString()
    };

    if (reviewedFormValues !== undefined) {
      updateData.reviewed_form_values = reviewedFormValues;
    }
    if (fieldReviewStatus !== undefined) {
      updateData.field_review_status = fieldReviewStatus;
    }
    if (fieldNotes !== undefined) {
      updateData.field_notes = fieldNotes;
    }
    if (staticQuestionResponses !== undefined) {
      updateData.static_question_responses = staticQuestionResponses;
    }
    if (staticQuestionNotes !== undefined) {
      updateData.static_question_notes = staticQuestionNotes;
    }
    if (notes !== undefined) {
      updateData.notes = notes;
    }
    // workflowStatus is intentionally NOT handled here to prevent bypassing stage validation

    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update(updateData)
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[DD Review] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to save review' });
    }

    // Add to history log
    await addHistoryLogEntry(submissionId, tenantCtx.tenantId, 'submission_updated', member.email, {
      fields_updated: Object.keys(updateData).filter(k => k !== 'updated_at')
    });

    let firstEditTransition = null;

    // Handle first edit stage transition if configured
    console.log(`[DD Review] Auto-transition check: isFirstEdit=${isFirstEdit}, form_id=${ddSubmission.form_submission?.form_id}`);
    if (isFirstEdit && ddSubmission.form_submission?.form_id) {
      try {
        // Get the DD config to check for on_first_edit_stage
        const { data: ddConfig, error: configError } = await supabase
          .from('form_due_diligence_config')
          .select('*')
          .eq('form_id', ddSubmission.form_submission.form_id)
          .eq('tenant_id', tenantCtx.tenantId)
          .single();

        console.log(`[DD Review] DD Config lookup: on_first_edit_stage=${ddConfig?.on_first_edit_stage}, configError=${configError?.message || 'none'}`);

        if (ddConfig?.on_first_edit_stage) {
          const targetStageId = ddConfig.on_first_edit_stage;
          const workflowStages = ddConfig.workflow_stages || [];
          const targetStage = workflowStages.find(s => s.id === targetStageId);

          console.log(`[DD Review] Target stage: id=${targetStageId}, found=${!!targetStage}, label=${targetStage?.label}, stageCount=${workflowStages.length}`);

          if (targetStage) {
            // Check if first_edit was already triggered (from the initial fetch)
            const alreadyTriggered = ddSubmission.first_edit_triggered === true;
            console.log(`[DD Review] Already triggered check: first_edit_triggered=${ddSubmission.first_edit_triggered}, alreadyTriggered=${alreadyTriggered}`);

            // Only proceed if not already triggered
            if (!alreadyTriggered) {
              // Set the flag to prevent duplicate transitions
              const { error: flagError } = await supabase
                .from('form_submission_due_diligence')
                .update({ 
                  first_edit_triggered: true,
                  updated_at: new Date().toISOString()
                })
                .eq('id', submissionId)
                .eq('tenant_id', tenantCtx.tenantId);

              if (flagError) {
                console.log(`[DD Review] Failed to set first_edit_triggered flag: ${flagError.message}`);
              }
              const previousStatus = ddSubmission.workflow_status;

              // Check selection conditions (same as update-status.js for consistency)
              const conditionCheck = evaluateStageConditions(targetStage, ddSubmission);
              console.log(`[DD Review] Condition check: canSelect=${conditionCheck.canSelect}, reasons=${JSON.stringify(conditionCheck.reasons)}, stageConditions=${JSON.stringify(targetStage.selection_conditions || 'none')}`);
              
              if (conditionCheck.canSelect) {
                // Update the submission status
                await supabase
                  .from('form_submission_due_diligence')
                  .update({
                    workflow_status: targetStageId,
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', submissionId)
                  .eq('tenant_id', tenantCtx.tenantId);

                // Refetch updated submission for webhooks and stage actions
                const { data: updatedSubmission } = await supabase
                  .from('form_submission_due_diligence')
                  .select('*, form_submission:form_submission_id(id, form_id)')
                  .eq('id', submissionId)
                  .eq('tenant_id', tenantCtx.tenantId)
                  .single();

                // Add to history log
                await addHistoryLogEntry(submissionId, tenantCtx.tenantId, 'status_changed', member.email, {
                  previous_status: previousStatus,
                  new_status: targetStageId,
                  trigger: 'first_edit_auto_transition'
                });

                // Trigger status change webhooks using updated submission
                const webhooksTriggered = [];
                const statusWebhooks = ddConfig.status_change_webhooks || [];
                
                for (const webhook of statusWebhooks) {
                  if (webhook.enabled !== false && webhook.trigger_status_id === targetStageId) {
                    try {
                      await triggerWebhook(webhook, updatedSubmission, ddConfig, null, member.email);
                      webhooksTriggered.push({ id: webhook.id, name: webhook.name, success: true });
                      await updateWebhookReminderStatus(submissionId, tenantCtx.tenantId, webhook.id, null, member.email);
                    } catch (webhookErr) {
                      console.error(`[DD Review Webhook] Failed to trigger ${webhook.name}:`, webhookErr);
                      webhooksTriggered.push({ id: webhook.id, name: webhook.name, success: false, error: webhookErr.message });
                    }
                  }
                }

                // Execute stage actions
                const actionResults = await executeStageActions(
                  targetStageId,
                  updatedSubmission,
                  tenantCtx.tenantId,
                  member.email,
                  {}
                );

                firstEditTransition = {
                  triggered: true,
                  previous_status: previousStatus,
                  new_status: targetStageId,
                  stage_label: targetStage.label,
                  webhooks_triggered: webhooksTriggered,
                  stage_actions_results: actionResults.stage_actions_results || []
                };

                console.log(`[DD Review] First edit auto-transition: ${previousStatus} -> ${targetStageId}`);
              } else {
                // Conditions not met - log but don't transition
                console.log(`[DD Review] First edit auto-transition skipped - conditions not met: ${conditionCheck.reasons.join(', ')}`);
                firstEditTransition = {
                  triggered: false,
                  skipped_reason: 'selection_conditions_not_met',
                  conditions_failed: conditionCheck.reasons
                };
              }
            } else {
              // Already triggered on a previous save
              console.log('[DD Review] First edit auto-transition skipped - first_edit_triggered flag already set');
            }
          }
        }
      } catch (transitionError) {
        console.error('[DD Review] First edit transition error:', transitionError);
        // Don't fail the save if the transition fails
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Review saved successfully',
      first_edit_transition: firstEditTransition
    });

  } catch (error) {
    console.error('[DD Review] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
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
      trigger_source: 'first_edit_auto_transition',
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
