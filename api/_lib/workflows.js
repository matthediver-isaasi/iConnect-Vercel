import { createClient } from '@supabase/supabase-js';
import { sendEmail, replacePlaceholders } from './emailService.js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Generate a password setup URL for new members (7 day validity)
async function generatePasswordSetupUrl(memberId, baseUrl) {
  if (!supabase || !memberId) return null;
  
  try {
    // First fetch the member's email
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('email')
      .eq('id', memberId)
      .single();
    
    if (memberError || !member?.email) {
      console.error('[Workflows] Could not fetch member email for password setup URL:', memberError);
      return null;
    }
    
    const resetToken = crypto.randomUUID();
    const resetTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // Check if credentials record exists
    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', memberId)
      .single();
    
    if (existingCreds) {
      // Update existing record
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        })
        .eq('member_id', memberId);
      
      if (updateError) {
        console.error('[Workflows] Error updating reset token:', updateError);
        return null;
      }
    } else {
      // Create new credentials record - include email for the record
      const { error: insertError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: memberId,
          email: member.email.toLowerCase(),
          password_hash: '',
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        });
      
      if (insertError) {
        console.error('[Workflows] Error inserting credentials with reset token:', insertError);
        return null;
      }
    }
    
    console.log(`[Workflows] Generated password setup token for member ${memberId} (${member.email})`);
    return `${baseUrl}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(member.email)}`;
  } catch (error) {
    console.error('[Workflows] Error generating password setup URL:', error);
    return null;
  }
}

// Process special placeholders like {{set_password_url}}
async function processSpecialPlaceholders(content, entityType, entityId, baseUrl) {
  if (!content || entityType !== 'member') return content;
  
  let result = content;
  
  // Handle {{set_password_url}} placeholder
  if (result.includes('{{set_password_url}}')) {
    const passwordUrl = await generatePasswordSetupUrl(entityId, baseUrl);
    if (passwordUrl) {
      result = result.replace(/\{\{set_password_url\}\}/g, passwordUrl);
      console.log(`[Workflows] Replaced {{set_password_url}} with ${passwordUrl}`);
    } else {
      console.warn('[Workflows] Failed to generate password setup URL, placeholder not replaced');
    }
  }
  
  return result;
}

// Apply field mappings to template - replaces placeholders with actual field values
async function applyFieldMappings(template, fieldMappings, entityType, entityId, entityData) {
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
      console.log(`[Workflows] Mapping "${placeholder}" -> core:${fieldId} = "${value}"`);
    } else if (fieldType === 'custom') {
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
      console.log(`[Workflows] Mapping "${placeholder}" -> custom:${fieldId} = "${value}"`);
    }
    
    // Replace both {{placeholder}} and [[placeholder]] syntax
    result = result.replace(new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'), value);
    result = result.replace(new RegExp(`\\[\\[${placeholder}\\]\\]`, 'g'), value);
  }
  
  return result;
}

// Resolve a field ID placeholder to actual value from preference values
async function resolveFieldIdPlaceholder(template, entityType, entityId) {
  if (!template || !supabase) return template;
  
  // Match UUID-style placeholders like {{4a53827a-d7f0-4e81-b0db-5671f537550a}}
  const uuidRegex = /\{\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/gi;
  const matches = template.match(uuidRegex);
  
  if (!matches) return template;
  
  let result = template;
  
  for (const match of matches) {
    const fieldId = match.replace(/[{}]/g, '');
    const tableName = entityType === 'organization' ? 'organization_preference_value' : 'member_preference_value';
    const foreignKey = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    console.log(`[Workflows] Resolving field ID ${fieldId} for ${entityType}:${entityId}`);
    
    const { data: prefValue } = await supabase
      .from(tableName)
      .select('value')
      .eq(foreignKey, entityId)
      .eq('field_id', fieldId)
      .single();
    
    if (prefValue?.value) {
      console.log(`[Workflows] Resolved field ${fieldId} to: ${prefValue.value}`);
      result = result.replace(match, prefValue.value);
    } else {
      console.log(`[Workflows] No value found for field ${fieldId}`);
    }
  }
  
  return result;
}

async function executeWorkflowActions(workflow, entityType, entityId, entityData, baseUrl) {
  const results = [];
  
  for (const action of (workflow.actions || [])) {
    if (action.type === 'update_field' && action.config?.field_type === 'core') {
      const table = entityType === 'organization' ? 'organization' : 'member';
      await supabase.from(table).update({ [action.config.field_id]: action.config.value }).eq('id', entityId);
      results.push({ action_type: 'update_field', status: 'success' });
    } else if (action.type === 'send_email') {
      console.log(`[Workflows] send_email action config:`, JSON.stringify(action.config, null, 2));
      
      let subject, body, fromEmail, replyTo;
      
      const useTemplateMode = (action.config?.mode === 'template' || action.config?.template_id) && action.config?.template_id;
      if (useTemplateMode) {
        console.log(`[Workflows] Using template mode, fetching template: ${action.config.template_id}`);
        const { data: template, error: templateError } = await supabase
          .from('email_template')
          .select('*')
          .eq('id', action.config.template_id)
          .single();
        
        console.log(`[Workflows] Template fetch result:`, template ? 'found' : 'not found', templateError ? templateError.message : '');
        
        if (!template || template.is_active === false) {
          console.log(`[Workflows] Email template ${action.config.template_id} not found or inactive`);
          results.push({ 
            action_type: 'send_email', 
            status: 'failed',
            error: 'Email template not found or inactive'
          });
          continue;
        }
        
        subject = template.subject || '';
        body = template.body || '';
        fromEmail = template.from_email;
        replyTo = template.reply_to;
        console.log(`[Workflows] Template loaded - subject: "${subject}", body length: ${body?.length}`);
        
        // Apply field mappings if configured
        if (action.config?.field_mappings && Object.keys(action.config.field_mappings).length > 0) {
          console.log(`[Workflows] Applying field mappings:`, JSON.stringify(action.config.field_mappings));
          subject = await applyFieldMappings(subject, action.config.field_mappings, entityType, entityId, entityData);
          body = await applyFieldMappings(body, action.config.field_mappings, entityType, entityId, entityData);
        }
      } else {
        subject = action.config?.subject || '';
        body = action.config?.body || '';
        console.log(`[Workflows] Using custom email mode`);
      }
      
      // First resolve field ID placeholders (UUIDs), then standard placeholders
      let toResolved = action.config?.to || '';
      if (action.config?.to_mode === 'field') {
        toResolved = await resolveFieldIdPlaceholder(toResolved, entityType, entityId);
      }
      const to = replacePlaceholders(toResolved, entityType, entityData);
      
      let ccResolved = action.config?.cc || '';
      ccResolved = await resolveFieldIdPlaceholder(ccResolved, entityType, entityId);
      const cc = ccResolved ? replacePlaceholders(ccResolved, entityType, entityData) : undefined;
      
      let bccResolved = action.config?.bcc || '';
      bccResolved = await resolveFieldIdPlaceholder(bccResolved, entityType, entityId);
      const bcc = bccResolved ? replacePlaceholders(bccResolved, entityType, entityData) : undefined;
      
      subject = replacePlaceholders(subject, entityType, entityData);
      body = replacePlaceholders(body, entityType, entityData);
      
      // Process special placeholders like {{set_password_url}}
      if (baseUrl) {
        subject = await processSpecialPlaceholders(subject, entityType, entityId, baseUrl);
        body = await processSpecialPlaceholders(body, entityType, entityId, baseUrl);
      }
      
      console.log(`[Workflows] Sending email - to: "${to}", subject: "${subject}", body length: ${body?.length}`);
      if (cc) console.log(`[Workflows] CC: "${cc}"`);
      if (bcc) console.log(`[Workflows] BCC: "${bcc}"`);
      
      const emailResult = await sendEmail({ to, subject, html: body, from: fromEmail, replyTo, cc, bcc });
      console.log(`[Workflows] Email result:`, JSON.stringify(emailResult));
      
      results.push({ 
        action_type: 'send_email', 
        status: emailResult.success ? 'success' : 'failed',
        messageId: emailResult.messageId,
        error: emailResult.error,
        template_id: action.config?.template_id
      });
    }
  }
  
  return results;
}

async function checkOncePerRecord(workflow, entityType, entityId) {
  if (workflow.trigger_mode !== 'once_per_record') return false;
  
  const { data: existingLogs } = await supabase
    .from('workflow_log')
    .select('id')
    .eq('workflow_id', workflow.id)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .limit(1);
  
  return existingLogs && existingLogs.length > 0;
}

async function logWorkflowExecution(workflow, entityType, entityId, triggerData, results) {
  await supabase.from('workflow_log').insert({
    workflow_id: workflow.id,
    entity_type: entityType,
    entity_id: entityId,
    trigger_data: triggerData,
    actions_executed: results,
    status: 'success'
  });
  console.log(`[Workflows] Logged execution for ${workflow.name}`);
}

export async function triggerWorkflows(entityType, entityId, beforeData, afterData, triggerType, baseUrl) {
  if (!supabase) return;
  
  try {
    const { data: workflows } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('is_active', true);

    if (!workflows || workflows.length === 0) return;
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType}:${entityId}`);

    for (const workflow of workflows) {
      let triggerMatches = false;
      
      if (workflow.trigger_type === 'record_update' && triggerType === 'field_change') {
        triggerMatches = true;
      } else if (workflow.trigger_type === 'record_create' && triggerType === 'record_create') {
        triggerMatches = true;
      } else if (workflow.trigger_type === 'field_change' && triggerType === 'field_change') {
        const cfg = workflow.trigger_config;
        if (cfg && cfg.field_id) {
          if (cfg.field_type === 'custom') {
            console.log(`[Workflows] Skipping custom field workflow "${workflow.name}" - handled by preference value update`);
            continue;
          }
          
          const before = String(beforeData?.[cfg.field_id] ?? '');
          const after = String(afterData?.[cfg.field_id] ?? '');
          const target = String(cfg.value ?? '');
          
          console.log(`[Workflows] Check ${workflow.name}: field=${cfg.field_id}, type=${cfg.field_type}, before="${before}", after="${after}", target="${target}", op=${cfg.operator}`);
          
          switch (cfg.operator) {
            case 'equals': triggerMatches = after.toLowerCase() === target.toLowerCase(); break;
            case 'changed': triggerMatches = before !== after; break;
            case 'changed_to': 
              triggerMatches = before !== after && after.toLowerCase() === target.toLowerCase();
              break;
            default: triggerMatches = false;
          }
          
          console.log(`[Workflows] Trigger match for ${workflow.name}: ${triggerMatches}`);
        }
      }

      if (!triggerMatches) continue;

      if (await checkOncePerRecord(workflow, entityType, entityId)) {
        console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
        continue;
      }

      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      const results = await executeWorkflowActions(workflow, entityType, entityId, afterData || {}, baseUrl);
      await logWorkflowExecution(workflow, entityType, entityId, { before: beforeData, after: afterData, trigger_type: triggerType }, results);
    }
  } catch (err) {
    console.error('[Workflows] Error:', err.message, err.stack);
  }
}

export async function triggerPreferenceWorkflows(entityType, entityId, fieldId, value, baseUrl) {
  if (!supabase) return;
  
  try {
    const { data: workflows } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('trigger_type', 'field_change')
      .eq('is_active', true);

    if (!workflows || workflows.length === 0) return;
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType} preference field ${fieldId}, incoming value="${value}"`);

    for (const workflow of workflows) {
      const cfg = workflow.trigger_config;
      console.log(`[Workflows] Checking workflow "${workflow.name}": cfg.field_id=${cfg?.field_id}, our fieldId=${fieldId}, cfg.field_type=${cfg?.field_type}`);
      
      if (!cfg || cfg.field_type !== 'custom' || cfg.field_id !== fieldId) {
        console.log(`[Workflows] Skipping - field mismatch or not custom field`);
        continue;
      }
      
      const target = String(cfg.value ?? '');
      const actual = String(value ?? '');
      let triggerMatches = false;
      
      console.log(`[Workflows] Comparing: actual="${actual}" vs target="${target}", operator=${cfg.operator}`);
      
      switch (cfg.operator) {
        case 'equals': triggerMatches = actual.toLowerCase() === target.toLowerCase(); break;
        case 'changed_to': triggerMatches = actual.toLowerCase() === target.toLowerCase(); break;
        case 'is_not_empty': triggerMatches = actual !== ''; break;
        default: triggerMatches = false;
      }
      
      console.log(`[Workflows] Result: triggerMatches=${triggerMatches}`);
      
      if (!triggerMatches) continue;
      
      if (await checkOncePerRecord(workflow, entityType, entityId)) {
        console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
        continue;
      }
      
      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      const table = entityType === 'organization' ? 'organization' : 'member';
      const { data: entityData } = await supabase.from(table).select('*').eq('id', entityId).single();
      
      const results = await executeWorkflowActions(workflow, entityType, entityId, entityData || {}, baseUrl);
      await logWorkflowExecution(workflow, entityType, entityId, { field_id: fieldId, value: value, trigger_type: 'field_change' }, results);
    }
  } catch (err) {
    console.error('[Workflows] Preference Error:', err.message, err.stack);
  }
}
