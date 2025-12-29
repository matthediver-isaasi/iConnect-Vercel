// Workflow Execution Engine
// Handles detecting field changes and executing workflow actions

import { createClient } from "@supabase/supabase-js";
import { sendEmail as sendMailgunEmail } from "./emailService";
import crypto from "crypto";

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
  cc?: string;
  bcc?: string;
  template_id?: string;
  field_mappings?: Record<string, string | null>;
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
  template_id?: string;
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
      .eq('field_id', fieldId)  // Note: DB column is 'field_id' (not preference_field_id)
      .single();
    
    return data?.value;
  }
}

// Apply field mappings to template - replaces placeholders with actual field values
async function applyFieldMappings(
  template: string, 
  fieldMappings: Record<string, string | null>, 
  entityType: string, 
  entityId: string, 
  entityData: any
): Promise<string> {
  if (!template || !fieldMappings || Object.keys(fieldMappings).length === 0) {
    return template;
  }
  
  let result = template;
  
  for (const [placeholder, mapping] of Object.entries(fieldMappings)) {
    if (!mapping) continue; // Skip auto mappings (null)
    
    const [fieldType, fieldId] = mapping.split(':');
    let value = '';
    
    if (fieldType === 'core') {
      // Core field - get directly from entity data
      value = entityData?.[fieldId] || '';
      console.log(`[Workflow Engine] Mapping "${placeholder}" -> core:${fieldId} = "${value}"`);
    } else if (fieldType === 'custom' && supabase) {
      // Custom field - look up from preference values
      const tableName = entityType === 'organization' ? 'organization_preference_value' : 'member_preference_value';
      const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';
      
      const { data: prefValue } = await supabase
        .from(tableName)
        .select('value')
        .eq(foreignKey, entityId)
        .eq('field_id', fieldId)
        .single();
      
      value = prefValue?.value || '';
      console.log(`[Workflow Engine] Mapping "${placeholder}" -> custom:${fieldId} = "${value}"`);
    }
    
    // Escape special regex characters in placeholder (especially . which is common in member.field patterns)
    const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Replace both {{placeholder}} and [[placeholder]] syntax
    result = result.replace(new RegExp(`\\{\\{${escapedPlaceholder}\\}\\}`, 'g'), value);
    result = result.replace(new RegExp(`\\[\\[${escapedPlaceholder}\\]\\]`, 'g'), value);
  }
  
  return result;
}

// Replace placeholders in template strings
function replacePlaceholders(template: string, entityType: string, entityData: any): string {
  // First handle {{placeholder}} syntax (form field mappings)
  let result = template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
    const parts = path.split('.');
    if (parts[0] === entityType || parts[0] === 'record') {
      const fieldName = parts[1] || parts[0];
      return entityData[fieldName] || match;
    }
    return entityData[path] || match;
  });
  
  // Then handle [[placeholder]] syntax (core database values like [[organization.id]], [[member.email]])
  result = result.replace(/\[\[(\w+(?:\.\w+)?)\]\]/g, (match, path) => {
    const parts = path.split('.');
    // Handle patterns like [[organization.id]], [[member.email]], [[record.field]]
    if (parts[0] === entityType || parts[0] === 'record' || parts[0] === 'organization' || parts[0] === 'member') {
      const fieldName = parts[1] || parts[0];
      return entityData[fieldName] || match;
    }
    return entityData[path] || match;
  });
  
  return result;
}

// Generate a password setup token and URL for a member
// This uses the same mechanism as password reset but for new users setting initial password
async function generatePasswordSetupUrl(memberId: string, memberEmail: string, baseUrl: string): Promise<string | null> {
  if (!supabase) return null;
  
  try {
    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days for new users
    
    // Check if credentials record exists
    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', memberId)
      .single();
    
    if (existingCreds) {
      await supabase
        .from('member_credentials')
        .update({
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        })
        .eq('id', existingCreds.id);
    } else {
      await supabase
        .from('member_credentials')
        .insert({
          member_id: memberId,
          email: memberEmail.toLowerCase(),
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        });
    }
    
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(memberEmail)}`;
    console.log(`[Workflow Engine] Generated password setup URL for ${memberEmail}`);
    return resetUrl;
  } catch (error) {
    console.error('[Workflow Engine] Failed to generate password setup URL:', error);
    return null;
  }
}

// Process special placeholders like {{set_password_url}} that require dynamic generation
async function processSpecialPlaceholders(
  template: string,
  entityType: string,
  entityId: string,
  entityData: any,
  baseUrl: string
): Promise<string> {
  let result = template;
  
  // Handle {{set_password_url}} placeholder - only for member entities
  if (entityType === 'member' && (template.includes('{{set_password_url}}') || template.includes('[[set_password_url]]'))) {
    const memberEmail = entityData?.email;
    if (memberEmail) {
      const passwordUrl = await generatePasswordSetupUrl(entityId, memberEmail, baseUrl);
      if (passwordUrl) {
        result = result.replace(/\{\{set_password_url\}\}/g, passwordUrl);
        result = result.replace(/\[\[set_password_url\]\]/g, passwordUrl);
      }
    }
  }
  
  return result;
}

// Execute email action
async function executeEmailAction(config: EmailActionConfig, entityType: string, entityId: string, entityData: any, baseUrl?: string): Promise<ExecutionResult> {
  let subject = config.subject || '';
  let body = config.body || '';
  
  // If using template mode, fetch the template content
  if (config.template_id && supabase) {
    try {
      const { data: template } = await supabase
        .from('email_template')
        .select('subject, body')
        .eq('id', config.template_id)
        .single();
      
      if (template) {
        subject = template.subject || subject;
        body = template.body || body;
        console.log(`[Workflow Engine] Using email template: ${config.template_id}`);
        
        // Apply field mappings if configured
        if (config.field_mappings && Object.keys(config.field_mappings).length > 0) {
          console.log(`[Workflow Engine] Applying field mappings:`, JSON.stringify(config.field_mappings));
          subject = await applyFieldMappings(subject, config.field_mappings, entityType, entityId, entityData);
          body = await applyFieldMappings(body, config.field_mappings, entityType, entityId, entityData);
        }
      } else {
        console.warn(`[Workflow Engine] Email template not found: ${config.template_id}`);
      }
    } catch (err) {
      console.error(`[Workflow Engine] Failed to fetch email template:`, err);
    }
  }

  const to = replacePlaceholders(config.to, entityType, entityData);
  let resolvedSubject = replacePlaceholders(subject, entityType, entityData);
  let resolvedBody = replacePlaceholders(body, entityType, entityData);
  const cc = config.cc ? replacePlaceholders(config.cc, entityType, entityData) : undefined;
  const bcc = config.bcc ? replacePlaceholders(config.bcc, entityType, entityData) : undefined;

  // Process special placeholders that require dynamic generation (like {{set_password_url}})
  if (baseUrl) {
    resolvedSubject = await processSpecialPlaceholders(resolvedSubject, entityType, entityId, entityData, baseUrl);
    resolvedBody = await processSpecialPlaceholders(resolvedBody, entityType, entityId, entityData, baseUrl);
  }

  console.log(`[Workflow Engine] Sending email to: ${to}`);
  console.log(`[Workflow Engine] Subject: ${resolvedSubject}`);
  if (cc) console.log(`[Workflow Engine] CC: ${cc}`);
  if (bcc) console.log(`[Workflow Engine] BCC: ${bcc}`);

  // Build email options
  const emailOptions: any = {
    to,
    subject: resolvedSubject,
    html: resolvedBody,
  };
  
  if (cc) emailOptions.cc = cc;
  if (bcc) emailOptions.bcc = bcc;

  // Send email via Mailgun
  const emailResult = await sendMailgunEmail(emailOptions);

  if (emailResult.success) {
    return {
      action_type: 'send_email',
      status: 'success',
      result: { to, subject: resolvedSubject, cc, bcc, messageId: emailResult.messageId }
    };
  } else {
    return {
      action_type: 'send_email',
      status: 'failed',
      error: emailResult.error || 'Failed to send email',
      template_id: config.template_id
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
        .eq('field_id', config.field_id)  // Note: DB column is 'field_id' (not preference_field_id)
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
            field_id: config.field_id,  // Note: DB column is 'field_id' (not preference_field_id)
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
  triggerType: 'field_change' | 'record_create' | 'record_update',
  baseUrl?: string
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
            result = await executeEmailAction(action.config as EmailActionConfig, entityType, entityId, afterData, baseUrl);
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
