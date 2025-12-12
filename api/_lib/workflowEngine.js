import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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
      return afterValue === null || afterValue === undefined || afterValue === '';
    case 'is_not_empty':
      return afterValue !== null && afterValue !== undefined && afterValue !== '';
    case 'changed_to':
      return beforeStr !== actualValue && actualValue.toLowerCase() === targetValue.toLowerCase();
    case 'changed_from':
      return beforeStr.toLowerCase() === targetValue.toLowerCase() && beforeStr !== actualValue;
    default:
      return false;
  }
}

async function getFieldValue(entityType, entityId, fieldId, fieldType, entityData) {
  if (!entityData) {
    return undefined;
  }
  
  if (fieldType === 'core') {
    return entityData[fieldId];
  } else {
    if (!supabase) return null;
    
    const tableName = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    const { data } = await supabase
      .from(tableName)
      .select('value')
      .eq(foreignKey, entityId)
      .eq('preference_field_id', fieldId)
      .single();
    
    return data?.value;
  }
}

function replacePlaceholders(template, entityType, entityData) {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
    const parts = path.split('.');
    if (parts[0] === entityType || parts[0] === 'record') {
      const fieldName = parts[1] || parts[0];
      return entityData[fieldName] || match;
    }
    return entityData[path] || match;
  });
}

async function executeEmailAction(config, entityType, entityData) {
  const to = replacePlaceholders(config.to, entityType, entityData);
  const subject = replacePlaceholders(config.subject, entityType, entityData);
  const body = replacePlaceholders(config.body, entityType, entityData);

  console.log(`[Workflow Engine] Sending email to: ${to}`);
  console.log(`[Workflow Engine] Subject: ${subject}`);
  console.log(`[Workflow Engine] Body: ${body}`);

  return {
    action_type: 'send_email',
    status: 'success',
    result: { to, subject, body, note: 'Email logged - integrate with email service for actual delivery' }
  };
}

async function executeUpdateFieldAction(config, entityType, entityId, entityData) {
  if (!supabase) {
    return { action_type: 'update_field', status: 'failed', error: 'Supabase not configured' };
  }

  const { field_id, field_type, value } = config;
  const processedValue = replacePlaceholders(value, entityType, entityData);

  console.log(`[Workflow Engine] Updating ${field_type} field ${field_id} to: ${processedValue}`);

  if (field_type === 'core') {
    const tableName = entityType === 'organization' ? 'organization' : 'member';
    const { error } = await supabase
      .from(tableName)
      .update({ [field_id]: processedValue })
      .eq('id', entityId);

    if (error) {
      return { action_type: 'update_field', status: 'failed', error: error.message };
    }
  } else {
    const tableName = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    const { data: existingPref } = await supabase
      .from(tableName)
      .select('id')
      .eq(foreignKey, entityId)
      .eq('preference_field_id', field_id)
      .single();

    if (existingPref) {
      const { error } = await supabase
        .from(tableName)
        .update({ value: processedValue })
        .eq('id', existingPref.id);
      if (error) {
        return { action_type: 'update_field', status: 'failed', error: error.message };
      }
    } else {
      const newRecord = {
        [foreignKey]: entityId,
        preference_field_id: field_id,
        value: processedValue
      };
      const { error } = await supabase
        .from(tableName)
        .insert(newRecord);
      if (error) {
        return { action_type: 'update_field', status: 'failed', error: error.message };
      }
    }
  }

  return {
    action_type: 'update_field',
    status: 'success',
    result: { field_id, field_type, new_value: processedValue }
  };
}

async function executeAction(action, entityType, entityId, entityData) {
  switch (action.type) {
    case 'send_email':
      return executeEmailAction(action.config, entityType, entityData);
    case 'update_field':
      return executeUpdateFieldAction(action.config, entityType, entityId, entityData);
    default:
      return { action_type: action.type, status: 'failed', error: `Unknown action type: ${action.type}` };
  }
}

async function logWorkflowExecution(workflowId, entityType, entityId, triggerData, actionsExecuted, status, errorMessage = null) {
  if (!supabase) return;

  try {
    await supabase
      .from('workflow_log')
      .insert({
        workflow_id: workflowId,
        entity_type: entityType,
        entity_id: entityId,
        trigger_data: triggerData,
        actions_executed: actionsExecuted,
        status,
        error_message: errorMessage
      });
  } catch (error) {
    console.error('[Workflow Engine] Failed to log workflow execution:', error);
  }
}

export async function evaluateWorkflows(entityType, entityId, beforeData, afterData, triggerType) {
  if (!supabase) {
    console.log('[Workflow Engine] Supabase not configured, skipping workflow evaluation');
    return;
  }

  try {
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

        if (!triggerMatches) {
          continue;
        }

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

        console.log(`[Workflow Engine] Executing actions for workflow: ${workflow.name}`);

        const executionResults = [];
        let hasFailure = false;

        for (const action of workflow.actions || []) {
          const result = await executeAction(action, entityType, entityId, afterData);
          executionResults.push(result);
          if (result.status === 'failed') {
            hasFailure = true;
          }
        }

        const status = executionResults.length === 0 
          ? 'success' 
          : hasFailure 
            ? (executionResults.some(r => r.status === 'success') ? 'partial' : 'failed')
            : 'success';

        await logWorkflowExecution(
          workflow.id,
          entityType,
          entityId,
          { trigger_type: workflow.trigger_type, trigger_config: workflow.trigger_config },
          executionResults,
          status,
          hasFailure ? executionResults.filter(r => r.status === 'failed').map(r => r.error).join('; ') : null
        );

        console.log(`[Workflow Engine] Workflow "${workflow.name}" completed with status: ${status}`);

      } catch (workflowError) {
        console.error(`[Workflow Engine] Error executing workflow ${workflow.name}:`, workflowError);
        await logWorkflowExecution(
          workflow.id,
          entityType,
          entityId,
          { trigger_type: workflow.trigger_type, trigger_config: workflow.trigger_config },
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
