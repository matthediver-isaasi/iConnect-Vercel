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
    
    const memberEmail = member.email.toLowerCase();
    const resetToken = crypto.randomUUID();
    const resetTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // Check if credentials record exists for this member_id
    const { data: existingCredsByMember } = await supabase
      .from('member_credentials')
      .select('id, email')
      .eq('member_id', memberId)
      .single();
    
    // Also check if credentials exist for this email (potentially different member)
    const { data: existingCredsByEmail } = await supabase
      .from('member_credentials')
      .select('id, member_id')
      .eq('email', memberEmail)
      .single();
    
    if (existingCredsByMember) {
      // Update existing record for this member
      console.log(`[Workflows] Updating existing credentials for member_id ${memberId}`);
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({
          email: memberEmail, // Update email in case it changed
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        })
        .eq('member_id', memberId);
      
      if (updateError) {
        console.error('[Workflows] Error updating reset token:', updateError);
        return null;
      }
    } else if (existingCredsByEmail) {
      // Credentials exist with this email but different member_id
      // Update the existing record to point to the new member
      console.log(`[Workflows] Found credentials by email, updating member_id from ${existingCredsByEmail.member_id} to ${memberId}`);
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({
          member_id: memberId,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        })
        .eq('email', memberEmail);
      
      if (updateError) {
        console.error('[Workflows] Error updating credentials by email:', updateError);
        return null;
      }
    } else {
      // No existing credentials - create new record
      console.log(`[Workflows] Creating new credentials for member ${memberId}`);
      const { error: insertError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: memberId,
          email: memberEmail,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString()
        });
      
      if (insertError) {
        console.error('[Workflows] Error inserting credentials with reset token:', insertError);
        return null;
      }
    }
    
    console.log(`[Workflows] Generated password setup token for member ${memberId} (${memberEmail})`);
    return `${baseUrl}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(memberEmail)}`;
  } catch (error) {
    console.error('[Workflows] Error generating password setup URL:', error);
    return null;
  }
}

// Process special placeholders like {{set_password_url}}
async function processSpecialPlaceholders(content, entityType, entityId, baseUrl) {
  console.log(`[processSpecialPlaceholders] Called with entityType="${entityType}", entityId="${entityId}", baseUrl="${baseUrl}"`);
  
  if (!content) {
    console.log(`[processSpecialPlaceholders] No content provided, returning`);
    return content;
  }
  
  if (entityType !== 'member') {
    console.log(`[processSpecialPlaceholders] entityType is "${entityType}", not "member", returning unchanged`);
    return content;
  }
  
  let result = content;
  
  // First, decode any HTML entities in the content for detection
  const decodedContent = result
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&lcub;/g, '{')
    .replace(/&rcub;/g, '}');
  
  // Use flexible regex that handles whitespace and is case-insensitive
  // Matches: {{set_password_url}}, {{ set_password_url }}, {{SET_PASSWORD_URL}}, etc.
  // Note: Use separate regex instances to avoid lastIndex issues with global flag
  const hasPlaceholder = /\{\{\s*set_password_url\s*\}\}/gi.test(decodedContent) || 
                         /\{\{\s*set_password_url\s*\}\}/gi.test(result);
  
  // Also check URL-encoded version
  const hasUrlEncodedPlaceholder = result.includes('%7B%7Bset_password_url%7D%7D') || 
                                    result.toLowerCase().includes('%7b%7bset_password_url%7d%7d');
  
  console.log(`[processSpecialPlaceholders] Placeholder detected: ${hasPlaceholder}, urlEncoded: ${hasUrlEncodedPlaceholder}`);
  
  // Handle {{set_password_url}} placeholder in all forms
  if (hasPlaceholder || hasUrlEncodedPlaceholder) {
    const passwordUrl = await generatePasswordSetupUrl(entityId, baseUrl);
    console.log(`[processSpecialPlaceholders] Generated passwordUrl: "${passwordUrl}"`);
    
    if (passwordUrl) {
      // Replace all forms of the placeholder (flexible regex with whitespace support)
      result = result.replace(/\{\{\s*set_password_url\s*\}\}/gi, passwordUrl);
      // HTML entity encoded versions
      result = result.replace(/&#123;&#123;\s*set_password_url\s*&#125;&#125;/gi, passwordUrl);
      result = result.replace(/&lcub;&lcub;\s*set_password_url\s*&rcub;&rcub;/gi, passwordUrl);
      // URL encoded version
      result = result.replace(/%7B%7Bset_password_url%7D%7D/gi, passwordUrl);
      console.log(`[Workflows] Replaced {{set_password_url}} with ${passwordUrl}`);
    } else {
      console.warn('[Workflows] Failed to generate password setup URL, placeholder not replaced');
    }
  } else {
    console.log(`[processSpecialPlaceholders] No set_password_url placeholder found in content`);
    // Log a snippet of the content to help debug
    console.log(`[processSpecialPlaceholders] Content snippet (first 500 chars): ${content.substring(0, 500)}`);
  }
  
  return result;
}

// Apply field mappings to template - replaces placeholders with actual field values
// If preserveEmpty is true, placeholders without values are left intact (useful for multi-pass processing)
async function applyFieldMappings(template, fieldMappings, entityType, entityId, entityData, preserveEmpty = false) {
  if (!template || !fieldMappings || Object.keys(fieldMappings).length === 0) {
    return template;
  }
  
  let result = template;
  
  for (const [placeholder, mapping] of Object.entries(fieldMappings)) {
    if (!mapping) continue; // Skip auto mappings (null)
    
    const [fieldType, fieldId] = mapping.split(':');
    let value = null;
    
    if (fieldType === 'core') {
      // Core field - get directly from entity data
      value = entityData?.[fieldId];
      console.log(`[Workflows] Mapping "${placeholder}" -> core:${fieldId} = "${value ?? '(not found)'}" [preserveEmpty=${preserveEmpty}]`);
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
      
      value = prefValue?.value;
      console.log(`[Workflows] Mapping "${placeholder}" -> custom:${fieldId} = "${value ?? '(not found)'}" [preserveEmpty=${preserveEmpty}]`);
    }
    
    // Only replace if we have a value, or if preserveEmpty is false (replace with empty string)
    if (value !== null && value !== undefined) {
      // Replace both {{placeholder}} and [[placeholder]] syntax
      result = result.replace(new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'), String(value));
      result = result.replace(new RegExp(`\\[\\[${placeholder}\\]\\]`, 'g'), String(value));
    } else if (!preserveEmpty) {
      // Replace with empty string only if preserveEmpty is false
      result = result.replace(new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'), '');
      result = result.replace(new RegExp(`\\[\\[${placeholder}\\]\\]`, 'g'), '');
    }
    // If preserveEmpty is true and no value, placeholder is left intact
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

// Helper function to get organization_id from entity
async function getOrganizationIdFromEntity(entityType, entityId, entityData) {
  if (entityType === 'organization') {
    return entityId;
  }
  
  // For member entities, get the organization_id from the member record
  if (entityData?.organization_id) {
    return entityData.organization_id;
  }
  
  // Fallback: fetch from database
  if (supabase && entityType === 'member') {
    const { data: member } = await supabase
      .from('member')
      .select('organization_id')
      .eq('id', entityId)
      .single();
    return member?.organization_id || null;
  }
  
  return null;
}

// Helper function to get members by role_id within an organization
async function getMembersByRoleInOrganization(roleId, organizationId) {
  if (!supabase || !roleId || !organizationId) {
    console.log(`[Workflows] getMembersByRoleInOrganization - missing params: roleId=${roleId}, orgId=${organizationId}`);
    return [];
  }
  
  console.log(`[Workflows] Fetching members with role ${roleId} in organization ${organizationId}`);
  
  const { data: members, error } = await supabase
    .from('member')
    .select('id, email, first_name, last_name, role_id, organization_id')
    .eq('role_id', roleId)
    .eq('organization_id', organizationId)
    .not('email', 'is', null);
  
  if (error) {
    console.error(`[Workflows] Error fetching members by role:`, error.message);
    return [];
  }
  
  // Filter out members without valid email addresses
  const validMembers = (members || []).filter(m => m.email && m.email.includes('@'));
  console.log(`[Workflows] Found ${validMembers.length} members with role ${roleId} in org ${organizationId}`);
  
  return validMembers;
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
      
      // Check if this is a role-based email (send to all members with a specific role)
      if (action.config?.to_mode === 'role' && action.config?.to_role_id) {
        const roleResults = await executeRoleBasedEmail(action, workflow, entityType, entityId, entityData, baseUrl);
        results.push(...roleResults);
        continue;
      }
      
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
      console.log(`[Workflows] baseUrl: "${baseUrl}", entityType: "${entityType}", entityId: "${entityId}"`);
      console.log(`[Workflows] Body contains set_password_url: ${body?.includes('set_password_url')}`);
      if (baseUrl) {
        subject = await processSpecialPlaceholders(subject, entityType, entityId, baseUrl);
        body = await processSpecialPlaceholders(body, entityType, entityId, baseUrl);
      } else {
        console.warn(`[Workflows] baseUrl is empty/undefined, cannot process special placeholders`);
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

// Execute role-based email: sends individual emails to all members with the specified role in the organization
async function executeRoleBasedEmail(action, workflow, entityType, entityId, entityData, baseUrl) {
  const results = [];
  const roleId = action.config.to_role_id;
  
  console.log(`[Workflows] Role-based email: sending to all members with role ${roleId}`);
  
  // Get organization context - CRITICAL for multi-tenant security
  const organizationId = await getOrganizationIdFromEntity(entityType, entityId, entityData);
  
  if (!organizationId) {
    console.error(`[Workflows] Role-based email failed: could not determine organization_id`);
    results.push({
      action_type: 'send_email_role',
      status: 'failed',
      error: 'Could not determine organization context for role-based email',
      role_id: roleId
    });
    return results;
  }
  
  // Fetch members with this role in the organization
  const members = await getMembersByRoleInOrganization(roleId, organizationId);
  
  if (members.length === 0) {
    console.log(`[Workflows] Role-based email: no members found with role ${roleId} in org ${organizationId}`);
    results.push({
      action_type: 'send_email_role',
      status: 'success',
      role_id: roleId,
      recipients_count: 0,
      message: 'No members found with specified role'
    });
    return results;
  }
  
  console.log(`[Workflows] Role-based email: sending to ${members.length} members`);
  
  // Get email template/content
  let subject, body, fromEmail, replyTo;
  
  const useTemplateMode = (action.config?.mode === 'template' || action.config?.template_id) && action.config?.template_id;
  if (useTemplateMode) {
    const { data: template, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', action.config.template_id)
      .single();
    
    if (!template || template.is_active === false) {
      console.log(`[Workflows] Role-based email template ${action.config.template_id} not found or inactive`);
      results.push({
        action_type: 'send_email_role',
        status: 'failed',
        error: 'Email template not found or inactive',
        role_id: roleId
      });
      return results;
    }
    
    subject = template.subject || '';
    body = template.body || '';
    fromEmail = template.from_email;
    replyTo = template.reply_to;
  } else {
    subject = action.config?.subject || '';
    body = action.config?.body || '';
  }
  
  // Get CC and BCC (same for all recipients)
  let ccResolved = action.config?.cc || '';
  ccResolved = await resolveFieldIdPlaceholder(ccResolved, entityType, entityId);
  const cc = ccResolved ? replacePlaceholders(ccResolved, entityType, entityData) : undefined;
  
  let bccResolved = action.config?.bcc || '';
  bccResolved = await resolveFieldIdPlaceholder(bccResolved, entityType, entityId);
  const bcc = bccResolved ? replacePlaceholders(bccResolved, entityType, entityData) : undefined;
  
  // Send email to each member individually with personalized placeholders
  let successCount = 0;
  let failCount = 0;
  const emailResults = [];
  
  // Keep original template for per-member processing
  // DON'T pre-resolve placeholders - this would blank out member placeholders
  const baseSubject = subject;
  const baseBody = body;
  
  for (const member of members) {
    try {
      // Start with fresh template for each member
      let memberSubject = baseSubject;
      let memberBody = baseBody;
      
      // Step 1: Apply field mappings for BOTH contexts (trigger entity + member)
      // Use preserveEmpty=true for trigger context so member placeholders survive
      if (action.config?.field_mappings && Object.keys(action.config.field_mappings).length > 0) {
        // Apply trigger entity field mappings first (with preserveEmpty=true)
        console.log(`[Workflows] Role-based email: applying trigger entity field mappings for ${entityType}:${entityId} (preserveEmpty=true)`);
        memberSubject = await applyFieldMappings(memberSubject, action.config.field_mappings, entityType, entityId, entityData, true);
        memberBody = await applyFieldMappings(memberBody, action.config.field_mappings, entityType, entityId, entityData, true);
        
        // Then apply member-specific field mappings (with preserveEmpty=false for final cleanup)
        console.log(`[Workflows] Role-based email: applying member field mappings for member ${member.id}`);
        memberSubject = await applyFieldMappings(memberSubject, action.config.field_mappings, 'member', member.id, member, false);
        memberBody = await applyFieldMappings(memberBody, action.config.field_mappings, 'member', member.id, member, false);
      }
      
      // Step 2: Resolve UUID-style field ID placeholders for member's custom fields
      memberSubject = await resolveFieldIdPlaceholder(memberSubject, 'member', member.id);
      memberBody = await resolveFieldIdPlaceholder(memberBody, 'member', member.id);
      
      // Step 3: Replace standard placeholders - member first, then trigger entity
      // Member placeholders: {{member.first_name}}, {{first_name}}, etc.
      memberSubject = replacePlaceholders(memberSubject, 'member', member);
      memberBody = replacePlaceholders(memberBody, 'member', member);
      
      // Trigger entity placeholders: {{organization.name}}, {{name}}, etc.
      memberSubject = replacePlaceholders(memberSubject, entityType, entityData);
      memberBody = replacePlaceholders(memberBody, entityType, entityData);
      
      // Step 4: Process special placeholders like {{set_password_url}} for THIS member
      if (baseUrl) {
        memberSubject = await processSpecialPlaceholders(memberSubject, 'member', member.id, baseUrl);
        memberBody = await processSpecialPlaceholders(memberBody, 'member', member.id, baseUrl);
      }
      
      console.log(`[Workflows] Role-based email: sending to ${member.email}`);
      
      const emailResult = await sendEmail({
        to: member.email,
        subject: memberSubject,
        html: memberBody,
        from: fromEmail,
        replyTo,
        cc,
        bcc
      });
      
      if (emailResult.success) {
        successCount++;
        emailResults.push({ email: member.email, status: 'success', messageId: emailResult.messageId });
      } else {
        failCount++;
        emailResults.push({ email: member.email, status: 'failed', error: emailResult.error });
      }
    } catch (err) {
      failCount++;
      console.error(`[Workflows] Role-based email error for ${member.email}:`, err.message);
      emailResults.push({ email: member.email, status: 'failed', error: err.message });
    }
  }
  
  console.log(`[Workflows] Role-based email complete: ${successCount} success, ${failCount} failed`);
  
  results.push({
    action_type: 'send_email_role',
    status: failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'failed'),
    role_id: roleId,
    recipients_count: members.length,
    success_count: successCount,
    fail_count: failCount,
    template_id: action.config?.template_id,
    details: emailResults
  });
  
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
