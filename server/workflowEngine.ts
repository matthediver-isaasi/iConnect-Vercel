// Workflow Execution Engine
// Handles detecting field changes and executing workflow actions

import { createClient } from "@supabase/supabase-js";
import { sendEmail as sendMailgunEmail } from "./emailService";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

interface TriggerConfig {
  field_id: string;
  field_type: 'core' | 'custom';
  operator: string;
  value: string;
}

interface Condition {
  field_id: string;
  field_type: 'core' | 'custom';
  operator: string;
  value: string;
  logic: 'AND' | 'OR';
}

interface EmailActionConfig {
  to: string;
  subject: string;
  body: string;
}

interface UpdateFieldActionConfig {
  field_id: string;
  field_type: 'core' | 'custom';
  value: string;
}

interface Action {
  type: 'send_email' | 'update_field';
  config: EmailActionConfig | UpdateFieldActionConfig;
}

interface Workflow {
  id: string;
  name: string;
  entity_type: 'organization' | 'member';
  trigger_type: 'field_change' | 'record_create' | 'record_update';
  trigger_config: TriggerConfig;
  conditions: Condition[];
  actions: Action[];
  is_active: boolean;
}

interface ExecutionResult {
  action_type: string;
  status: 'success' | 'failed';
  result?: any;
  error?: string;
}

// Evaluate a single condition against entity data
function evaluateCondition(
  condition: { operator: string; value: string; field_id: string; field_type: string },
  beforeValue: any,
  afterValue: any
): boolean {
  const { operator, value } = condition;
  // Use nullish coalescing to preserve 0 and false values
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
      // Only null, undefined, or empty string are considered empty (not 0 or false)
      return afterValue === null || afterValue === undefined || afterValue === '';
    case 'is_not_empty':
      // 0 and false are valid non-empty values
      return afterValue !== null && afterValue !== undefined && afterValue !== '';
    case 'changed_to':
      return beforeStr !== actualValue && actualValue.toLowerCase() === targetValue.toLowerCase();
    case 'changed_from':
      return beforeStr.toLowerCase() === targetValue.toLowerCase() && beforeStr !== actualValue;
    default:
      return false;
  }
}

// Get field value from entity, handling both core and custom fields
async function getFieldValue(
  entityType: string,
  entityId: string,
  fieldId: string,
  fieldType: string,
  entityData: any
): Promise<any> {
  // Handle null/undefined entityData (e.g., beforeData on record_create)
  if (!entityData) {
    return undefined;
  }
  
  if (fieldType === 'core') {
    return entityData[fieldId];
  } else {
    // Custom field - fetch from preference values
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

// Replace placeholders in template strings
function replacePlaceholders(template: string, entityType: string, entityData: any): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
    const parts = path.split('.');
    if (parts[0] === entityType || parts[0] === 'record') {
      const fieldName = parts[1] || parts[0];
      return entityData[fieldName] || match;
    }
    return entityData[path] || match;
  });
}

// Execute email action
async function executeEmailAction(config: EmailActionConfig, entityType: string, entityData: any): Promise<ExecutionResult> {
  const to = replacePlaceholders(config.to, entityType, entityData);
  const subject = replacePlaceholders(config.subject, entityType, entityData);
  const body = replacePlaceholders(config.body, entityType, entityData);

  console.log(`[Workflow Engine] Sending email to: ${to}`);
  console.log(`[Workflow Engine] Subject: ${subject}`);

  // Send email via Mailgun
  const emailResult = await sendMailgunEmail({
    to,
    subject,
    html: body,
  });

  if (emailResult.success) {
    return {
      action_type: 'send_email',
      status: 'success',
      result: { to, subject, messageId: emailResult.messageId }
    };
  } else {
    return {
      action_type: 'send_email',
      status: 'failed',
      error: emailResult.error || 'Failed to send email'
    };
  }
}

// Execute update field action
async function executeUpdateFieldAction(
  config: UpdateFieldActionConfig,
  entityType: string,
  entityId: string,
  entityData: any
): Promise<ExecutionResult> {
  if (!supabase) {
    return { action_type: 'update_field', status: 'failed', error: 'Supabase not configured' };
  }

  const newValue = replacePlaceholders(config.value, entityType, entityData);

  try {
    if (config.field_type === 'core') {
      const tableName = entityType === 'organization' ? 'organization' : 'member';
      const { error } = await supabase
        .from(tableName)
        .update({ [config.field_id]: newValue })
        .eq('id', entityId);

      if (error) throw error;
    } else {
      // Custom field update
      const tableName = entityType === 'organization' 
        ? 'organization_preference_value' 
        : 'member_preference_value';
      const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';

      const { data: existing } = await supabase
        .from(tableName)
        .select('id')
        .eq(foreignKey, entityId)
        .eq('preference_field_id', config.field_id)
        .single();

      if (existing) {
        const { error } = await supabase
          .from(tableName)
          .update({ value: newValue })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from(tableName)
          .insert({
            [foreignKey]: entityId,
            preference_field_id: config.field_id,
            value: newValue
          });
        if (error) throw error;
      }
    }

    console.log(`[Workflow Engine] Updated field ${config.field_id} to: ${newValue}`);
    return { action_type: 'update_field', status: 'success', result: { field_id: config.field_id, new_value: newValue } };
  } catch (error: any) {
    console.error(`[Workflow Engine] Failed to update field:`, error);
    return { action_type: 'update_field', status: 'failed', error: error.message };
  }
}

// Log workflow execution
async function logExecution(
  workflowId: string,
  entityType: string,
  entityId: string,
  triggerData: any,
  actionsExecuted: ExecutionResult[],
  status: 'success' | 'partial' | 'failed',
  errorMessage?: string
): Promise<void> {
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
export async function evaluateWorkflows(
  entityType: 'organization' | 'member',
  entityId: string,
  beforeData: any,
  afterData: any,
  triggerType: 'field_change' | 'record_create' | 'record_update'
): Promise<void> {
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

    for (const workflow of workflows as Workflow[]) {
      try {
        // Check if trigger matches
        let triggerMatches = false;

        if (workflow.trigger_type === 'record_update' && triggerType === 'field_change') {
          triggerMatches = true;
        } else if (workflow.trigger_type === 'record_create' && triggerType === 'record_create') {
          triggerMatches = true;
        } else if (workflow.trigger_type === 'field_change' && triggerType === 'field_change') {
          // Check specific field trigger
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
        const executionResults: ExecutionResult[] = [];
        let hasFailures = false;

        for (const action of workflow.actions) {
          let result: ExecutionResult;

          if (action.type === 'send_email') {
            result = await executeEmailAction(action.config as EmailActionConfig, entityType, afterData);
          } else if (action.type === 'update_field') {
            result = await executeUpdateFieldAction(action.config as UpdateFieldActionConfig, entityType, entityId, afterData);
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

      } catch (workflowError: any) {
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
