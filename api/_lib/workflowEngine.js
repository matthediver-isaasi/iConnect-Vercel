// Workflow Execution Engine for Vercel API
// Handles detecting field changes and executing workflow actions

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Evaluate a single condition against entity data
function evaluateCondition(condition, beforeValue, afterValue) {
  const { operator, value } = condition;
  const actualValue = String(afterValue ?? '');
  const targetValue = String(value ?? '');
  const beforeStr = String(beforeValue ?? '');

  switch (operator) {
    case 'equals':
      return actualValue.toLowerCase() === targetValue.toLowerCase();
    case 'not_equals':
      return actualValue.toLowerCase() !== targetValue.toLowerCase();
    case 'contains':
      return actualValue.toLowerCase().includes(targetValue.toLowerCase());
    case 'not_contains':
      return !actualValue.toLowerCase().includes(targetValue.toLowerCase());
    case 'starts_with':
      return actualValue.toLowerCase().startsWith(targetValue.toLowerCase());
    case 'ends_with':
      return actualValue.toLowerCase().endsWith(targetValue.toLowerCase());
    case 'is_empty':
      return actualValue === '' || actualValue === 'null' || actualValue === 'undefined';
    case 'is_not_empty':
      return actualValue !== '' && actualValue !== 'null' && actualValue !== 'undefined';
    case 'changed':
      return beforeStr !== actualValue;
    case 'changed_to':
      return beforeStr !== actualValue && actualValue.toLowerCase() === targetValue.toLowerCase();
    case 'changed_from':
      return beforeStr !== actualValue && beforeStr.toLowerCase() === targetValue.toLowerCase();
    default:
      console.log(`[Workflow Engine] Unknown operator: ${operator}`);
      return false;
  }
}

// Get field value from entity data (core or custom field)
async function getFieldValue(entityType, entityId, fieldId, fieldType, entityData) {
  if (!supabase) return null;

  if (fieldType === 'core') {
    return entityData?.[fieldId] ?? null;
  } else if (fieldType === 'custom') {
    const tableName = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';

    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('value')
        .eq(foreignKey, entityId)
        .eq('preference_field_id', fieldId)
        .single();

      if (error || !data) return null;
      return data.value;
    } catch (err) {
      console.error('[Workflow Engine] Error fetching custom field value:', err);
      return null;
    }
  }
  return null;
}

// Execute email action (placeholder - would need email service integration)
async function executeEmailAction(config, entityType, entityData) {
  try {
    console.log(`[Workflow Engine] Sending email to: ${config.to}, subject: ${config.subject}`);
    // Email sending would be implemented here
    return { action_type: 'send_email', status: 'success', result: { to: config.to } };
  } catch (error) {
    return { action_type: 'send_email', status: 'failed', error: error.message };
  }
}

// Execute update field action
async function executeUpdateFieldAction(config, entityType, entityId, entityData) {
  if (!supabase) {
    return { action_type: 'update_field', status: 'failed', error: 'Supabase not configured' };
  }

  try {
    if (config.field_type === 'core') {
      const tableName = entityType === 'organization' ? 'organization' : 'member';
      const { error } = await supabase
        .from(tableName)
        .update({ [config.field_id]: config.value })
        .eq('id', entityId);

      if (error) throw error;
      return { action_type: 'update_field', status: 'success', result: { field: config.field_id, value: config.value } };
    } else if (config.field_type === 'custom') {
      const tableName = entityType === 'organization' 
        ? 'organization_preference_value' 
        : 'member_preference_value';
      const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';

      const { error } = await supabase
        .from(tableName)
        .upsert({
          [foreignKey]: entityId,
          preference_field_id: config.field_id,
          value: config.value
        }, {
          onConflict: `${foreignKey},preference_field_id`
        });

      if (error) throw error;
      return { action_type: 'update_field', status: 'success', result: { field: config.field_id, value: config.value } };
    }
    return { action_type: 'update_field', status: 'failed', error: 'Invalid field type' };
  } catch (error) {
    return { action_type: 'update_field', status: 'failed', error: error.message };
  }
}

// Log workflow execution
async function logExecution(workflowId, entityType, entityId, triggerData, actionsExecuted, status, errorMessage) {
  if (!supabase) return;

  try {
    await supabase.from('workflow_log').insert({
      workflow_id: workflowId,
      entity_type: entityType,
      entity_id: entityId,
      trigger_data: triggerData,
      actions_executed: actionsExecuted,
      status,
      error_message: errorMessage
    });
  } catch (error) {
    console.error('[Workflow Engine] Failed to log execution:', error);
  }
}

// Main function to evaluate and execute workflows
export async function evaluateWorkflows(entityType, entityId, beforeData, afterData, triggerType) {
  if (!supabase) {
    console.log('[Workflow Engine] Supabase not configured, skipping workflow evaluation');
    return;
  }

  try {
    // Fetch active workflows for this entity type
    const { data: workflows, error } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('is_active', true);

    if (error || !workflows || workflows.length === 0) {
      return;
    }

    console.log(`[Workflow Engine] Found ${workflows.length} active workflows for ${entityType}`);

    for (const workflow of workflows) {
      try {
        let triggerMatches = false;

        if (workflow.trigger_type === 'record_update' && triggerType === 'field_change') {
          triggerMatches = true;
        } else if (workflow.trigger_type === 'record_create' && triggerType === 'record_create') {
          triggerMatches = true;
        } else if (workflow.trigger_type === 'field_change' && triggerType === 'field_change') {
          const triggerConfig = workflow.trigger_config;
          if (triggerConfig && triggerConfig.field_id) {
            const beforeValue = await getFieldValue(entityType, entityId, triggerConfig.field_id, triggerConfig.field_type, beforeData);
            const afterValue = await getFieldValue(entityType, entityId, triggerConfig.field_id, triggerConfig.field_type, afterData);
            
            triggerMatches = evaluateCondition(triggerConfig, beforeValue, afterValue);
            console.log(`[Workflow Engine] Trigger evaluation for ${workflow.name}: field=${triggerConfig.field_id}, before=${beforeValue}, after=${afterValue}, matches=${triggerMatches}`);
          }
        }

        if (!triggerMatches) continue;

        // Evaluate additional conditions
        let allConditionsMet = true;
        if (workflow.conditions && workflow.conditions.length > 0) {
          for (let i = 0; i < workflow.conditions.length; i++) {
            const condition = workflow.conditions[i];
            const beforeValue = await getFieldValue(entityType, entityId, condition.field_id, condition.field_type, beforeData);
            const afterValue = await getFieldValue(entityType, entityId, condition.field_id, condition.field_type, afterData);
            
            const conditionMet = evaluateCondition(condition, beforeValue, afterValue);
            
            if (i === 0) {
              allConditionsMet = conditionMet;
            } else {
              if (condition.logic === 'AND') {
                allConditionsMet = allConditionsMet && conditionMet;
              } else {
                allConditionsMet = allConditionsMet || conditionMet;
              }
            }
          }
        }

        if (!allConditionsMet) {
          console.log(`[Workflow Engine] Conditions not met for workflow: ${workflow.name}`);
          continue;
        }

        console.log(`[Workflow Engine] Executing workflow: ${workflow.name}`);

        // Execute actions
        const executionResults = [];
        let hasFailures = false;

        for (const action of workflow.actions) {
          let result;

          if (action.type === 'send_email') {
            result = await executeEmailAction(action.config, entityType, afterData);
          } else if (action.type === 'update_field') {
            result = await executeUpdateFieldAction(action.config, entityType, entityId, afterData);
          } else {
            result = { action_type: action.type, status: 'failed', error: 'Unknown action type' };
          }

          executionResults.push(result);
          if (result.status === 'failed') hasFailures = true;
        }

        // Log execution
        const status = hasFailures 
          ? (executionResults.some(r => r.status === 'success') ? 'partial' : 'failed')
          : 'success';

        await logExecution(
          workflow.id,
          entityType,
          entityId,
          { before: beforeData, after: afterData, trigger_type: triggerType },
          executionResults,
          status
        );

        console.log(`[Workflow Engine] Workflow ${workflow.name} executed with status: ${status}`);

      } catch (workflowError) {
        console.error(`[Workflow Engine] Error executing workflow ${workflow.name}:`, workflowError);
        await logExecution(
          workflow.id,
          entityType,
          entityId,
          { before: beforeData, after: afterData, trigger_type: triggerType },
          [],
          'failed',
          workflowError.message
        );
      }
    }
  } catch (error) {
    console.error('[Workflow Engine] Error evaluating workflows:', error);
  }
}
