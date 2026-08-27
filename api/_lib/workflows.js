import { sendEmail, replacePlaceholders } from './emailService.js';
import { buildInboxDelivery } from './transactionalInbox.js';
import { applyDdOwnerPlaceholders, resolveDdOwnerForSubmission } from './ddOwner.js';
import { buildContractBracketPlaceholders, replaceContractBracketPlaceholders } from './contractPlaceholders.js';
import crypto from 'crypto';
import { supabase } from './database.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from './membershipSimulation.js';
import { getConfigForMember } from './membershipConfigResolver.js';
import { autoApproveMemberFees, autoApproveOrgFees } from './membershipFeeApproval.js';
import { coerceBooleanPreferenceValue } from './booleanCoercion.js';
import { getTenantBaseUrl } from './campaignService.js';
import { hasSetPasswordToken } from './passwordSetupUrl.js';
import { isProtectedOrgBalanceField } from './protectedOrgFields.js';
import {
  fireNewZeroDueMembershipPaidWorkflow,
  isZeroDueExistingMembership,
  isZeroDueMembership,
  zeroDuePaymentFields,
} from './zeroDueMembership.js';

// Task #3253 — when a workflow fires from a background/webhook path with no
// request context (empty baseUrl) but the email template contains special
// placeholders like {{set_password_url}}, derive the tenant's canonical base
// URL from its slug so the link can still be minted.
export async function resolveWorkflowBaseUrl(baseUrl, tenantId) {
  if (baseUrl) return baseUrl;
  if (!tenantId || !supabase) return '';
  try {
    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .maybeSingle();
    if (tenant?.slug) {
      const derived = getTenantBaseUrl(tenant.slug);
      console.log(`[Workflows] baseUrl empty - derived "${derived}" from tenant slug "${tenant.slug}"`);
      return derived;
    }
    console.warn(`[Workflows] baseUrl empty and tenant ${tenantId} has no slug - cannot derive base URL`);
  } catch (e) {
    console.warn(`[Workflows] baseUrl fallback lookup failed for tenant ${tenantId}:`, e.message);
  }
  return '';
}

// Task #3253 — final safety net: never let a raw {{set_password_url}} /
// [[set_password_url]] token reach a recipient. Returns the cleaned string.
export function stripUnresolvedSetPasswordToken(str, label) {
  if (typeof str !== 'string' || !str) return str;
  if (!hasSetPasswordToken(str)) return str;
  console.warn(`[Workflows] Unresolved set_password_url placeholder stripped from ${label} before send`);
  return str
    .replace(/\{\{\s*set_password_url\s*\}\}/gi, '')
    .replace(/\[\[\s*set_password_url\s*\]\]/gi, '');
}

// Attempts to parse a stringified JSON array. Returns the parsed array
// (with each element coerced to string) on success, or null when the value
// is not a JSON-encoded array. Used by `contains`/`not_contains` workflow
// condition operators so multi-select preference values match by exact
// element rather than naive substring (e.g. so "Grade 1" does not match
// against the stored string "Grade 10").
function tryParseJsonArray(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : null;
  } catch {
    return null;
  }
}

// Date/time comparison operators. These are evaluated against the current
// date/time at evaluation. "today" semantics are date-only and computed in
// UTC (the schedule/condition timezone assumption is UTC); "past"/"future"
// semantics use the full timestamp. Empty or unparseable values never match
// (and never throw).
const DATE_OPERATORS = new Set([
  'date_is_today',
  'date_before_today',
  'date_after_today',
  'date_in_past',
  'date_in_future',
  'date_days_ago',
  'date_days_from_now',
  'date_within_days',
]);

function isDateOperator(op) {
  return DATE_OPERATORS.has(op);
}

function parseDateValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d;
}

// Whole-day difference between the given date and "today", both reduced to
// UTC midnight. Negative = in the past, 0 = today, positive = in the future.
function daysFromTodayUTC(d) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const dateUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((dateUTC - todayUTC) / DAY_MS);
}

function evaluateDateOperator(operator, rawValue, conditionValue) {
  const d = parseDateValue(rawValue);
  if (!d) return false; // empty/invalid -> no match, no crash

  if (operator === 'date_in_past') return d.getTime() < Date.now();
  if (operator === 'date_in_future') return d.getTime() > Date.now();

  const diff = daysFromTodayUTC(d);
  switch (operator) {
    case 'date_is_today': return diff === 0;
    case 'date_before_today': return diff < 0;
    case 'date_after_today': return diff > 0;
    case 'date_days_ago': {
      const n = parseInt(conditionValue, 10);
      return Number.isFinite(n) && diff === -n;
    }
    case 'date_days_from_now': {
      const n = parseInt(conditionValue, 10);
      return Number.isFinite(n) && diff === n;
    }
    case 'date_within_days': {
      const n = parseInt(conditionValue, 10);
      return Number.isFinite(n) && diff >= 0 && diff <= n;
    }
    default: return false;
  }
}

// Single source of truth for evaluating a condition operator. Shared by the
// event-driven entry points (triggerWorkflows, triggerPreferenceWorkflows)
// and the scheduled evaluation path so all three stay consistent. `beforeValue`
// is only meaningful for change-based operators (changed_to/changed_from); the
// scheduled path has no "before" so it passes undefined.
export function evaluateConditionOperator(operator, afterValue, conditionValue, beforeValue) {
  if (isDateOperator(operator)) {
    return evaluateDateOperator(operator, afterValue, conditionValue);
  }

  const actualValue = String(afterValue ?? '');
  const targetValue = String(conditionValue ?? '');
  const beforeStr = String(beforeValue ?? '');
  const actualNumber = Number(afterValue);
  const targetNumber = Number(conditionValue);
  const hasNumericValues = afterValue !== null && afterValue !== undefined && afterValue !== ''
    && conditionValue !== null && conditionValue !== undefined && conditionValue !== ''
    && Number.isFinite(actualNumber) && Number.isFinite(targetNumber);

  switch (operator) {
    case 'equals':
      return actualValue.toLowerCase() === targetValue.toLowerCase();
    case 'not_equals':
      return actualValue.toLowerCase() !== targetValue.toLowerCase();
    case 'contains': {
      const arr = tryParseJsonArray(actualValue);
      if (arr) return arr.some(el => String(el).toLowerCase() === targetValue.toLowerCase());
      return actualValue.toLowerCase().includes(targetValue.toLowerCase());
    }
    case 'not_contains': {
      const arr = tryParseJsonArray(actualValue);
      if (arr) return !arr.some(el => String(el).toLowerCase() === targetValue.toLowerCase());
      return !actualValue.toLowerCase().includes(targetValue.toLowerCase());
    }
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
    case 'greater_than':
      return hasNumericValues && actualNumber > targetNumber;
    case 'greater_than_or_equal':
      return hasNumericValues && actualNumber >= targetNumber;
    case 'less_than':
      return hasNumericValues && actualNumber < targetNumber;
    case 'less_than_or_equal':
      return hasNumericValues && actualNumber <= targetNumber;
    default:
      return false;
  }
}

// Generate a password setup URL for new members (7 day validity)
async function generatePasswordSetupUrl(memberId, baseUrl) {
  if (!supabase || !memberId) {
    console.warn(`[Workflows] generatePasswordSetupUrl: missing params - supabase=${!!supabase}, memberId=${memberId}`);
    return null;
  }
  if (!baseUrl) {
    console.warn(`[Workflows] generatePasswordSetupUrl: baseUrl is empty/missing, cannot generate URL`);
    return null;
  }
  
  try {
    // First fetch the member's email
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('email')
      .eq('id', memberId)
      .single();
    
    if (memberError || !member?.email) {
      console.error(`[Workflows] Could not fetch member email for password setup URL (memberId=${memberId}):`, memberError?.message || 'no email found');
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
                         /\{\{\s*set_password_url\s*\}\}/gi.test(result) ||
                         /\[\[\s*set_password_url\s*\]\]/gi.test(decodedContent) ||
                         /\[\[\s*set_password_url\s*\]\]/gi.test(result);
  
  // Also check URL-encoded version
  const hasUrlEncodedPlaceholder = result.includes('%7B%7Bset_password_url%7D%7D') || 
                                    result.toLowerCase().includes('%7b%7bset_password_url%7d%7d');
  
  console.log(`[processSpecialPlaceholders] Placeholder detected: ${hasPlaceholder}, urlEncoded: ${hasUrlEncodedPlaceholder}`);
  
  // Handle {{set_password_url}} placeholder in all forms
  if (hasPlaceholder || hasUrlEncodedPlaceholder) {
    const passwordUrl = await generatePasswordSetupUrl(entityId, baseUrl);
    console.log(`[processSpecialPlaceholders] Generated passwordUrl: "${passwordUrl}"`);
    
    if (passwordUrl) {
      const passwordLink = `<a href="${passwordUrl}" style="color: #0066cc; text-decoration: underline;">Set your password</a>`;
      // Replace all forms of the placeholder (flexible regex with whitespace support)
      result = result.replace(/\{\{\s*set_password_url\s*\}\}/gi, passwordLink);
      // Also replace [[set_password_url]] syntax
      result = result.replace(/\[\[\s*set_password_url\s*\]\]/gi, passwordLink);
      // HTML entity encoded versions
      result = result.replace(/&#123;&#123;\s*set_password_url\s*&#125;&#125;/gi, passwordLink);
      result = result.replace(/&lcub;&lcub;\s*set_password_url\s*&rcub;&rcub;/gi, passwordLink);
      // URL encoded version
      result = result.replace(/%7B%7Bset_password_url%7D%7D/gi, passwordLink);
      console.log(`[Workflows] Replaced {{set_password_url}} with HTML link: ${passwordUrl}`);
    } else {
      console.warn(`[Workflows] Failed to generate password setup URL for member ${entityId}, removing placeholder to avoid raw text in email`);
      // Remove the placeholder rather than leaving raw {{set_password_url}} text in the email
      result = result.replace(/\{\{\s*set_password_url\s*\}\}/gi, '');
      result = result.replace(/\[\[\s*set_password_url\s*\]\]/gi, '');
      result = result.replace(/&#123;&#123;\s*set_password_url\s*&#125;&#125;/gi, '');
      result = result.replace(/&lcub;&lcub;\s*set_password_url\s*&rcub;&rcub;/gi, '');
      result = result.replace(/%7B%7Bset_password_url%7D%7D/gi, '');
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
  
  const SPECIAL_PLACEHOLDERS = ['set_password_url', 'communication_preferences_link', 'communication_preferences_url'];
  
  for (const [placeholder, mapping] of Object.entries(fieldMappings)) {
    if (!mapping) continue; // Skip auto mappings (null)
    
    // Never touch special placeholders - they are handled by dedicated processors later
    if (SPECIAL_PLACEHOLDERS.includes(placeholder)) {
      console.log(`[Workflows] Skipping special placeholder "${placeholder}" - handled by dedicated processor`);
      continue;
    }
    
    // Handle prefixes: org_core, org_custom, member_core, member_custom, core, custom
    const parts = mapping.split(':');
    const fieldType = parts[0];
    const fieldId = parts.slice(1).join(':'); // Handle cases where fieldId might contain colons
    let value = null;
    
    // Determine which entity type this mapping refers to
    const isOrgField = fieldType.startsWith('org_');
    const isMemberField = fieldType.startsWith('member_');
    const isJobPostingField = fieldType.startsWith('job_posting_');
    const normalizedFieldType = fieldType.replace(/^(org_|member_|job_posting_)/, '');
    
    // Determine which entity to look up from
    let lookupEntityType = entityType;
    let lookupEntityId = entityId;
    let lookupEntityData = entityData;
    
    // If the mapping specifies a different entity type than what we're processing,
    // skip it - let a later pass with the correct entity data handle it
    if (isOrgField && entityType !== 'organization') {
      console.log(`[Workflows] Mapping "${placeholder}" refers to org but entityType is ${entityType} - skipping for later pass`);
      continue; // Skip this mapping, let later pass handle it
    } else if (isMemberField && entityType !== 'member') {
      console.log(`[Workflows] Mapping "${placeholder}" refers to member but entityType is ${entityType} - skipping for later pass`);
      continue; // Skip this mapping, let later pass handle it
    } else if (isJobPostingField && entityType !== 'job_posting') {
      console.log(`[Workflows] Mapping "${placeholder}" refers to job_posting but entityType is ${entityType} - skipping for later pass`);
      continue; // Skip this mapping, let later pass handle it
    }
    
    if (normalizedFieldType === 'core') {
      // Core field - get directly from entity data
      value = lookupEntityData?.[fieldId];
      console.log(`[Workflows] Mapping "${placeholder}" -> ${fieldType}:${fieldId} = "${value ?? '(not found)'}" [preserveEmpty=${preserveEmpty}]`);
    } else if (normalizedFieldType === 'custom') {
      // Custom field - look up from preference values
      const tableName = lookupEntityType === 'organization' ? 'organization_preference_value' : 'member_preference_value';
      const foreignKey = lookupEntityType === 'organization' ? 'organization_id' : 'member_id';
      
      const { data: prefValue } = await supabase
        .from(tableName)
        .select('value')
        .eq(foreignKey, lookupEntityId)
        .eq('field_id', fieldId)
        .single();
      
      value = prefValue?.value;
      console.log(`[Workflows] Mapping "${placeholder}" -> ${fieldType}:${fieldId} = "${value ?? '(not found)'}" [preserveEmpty=${preserveEmpty}]`);
    } else {
      console.log(`[Workflows] Unknown field type "${fieldType}" for placeholder "${placeholder}"`);
    }
    
    // Only replace if we have a value, or if preserveEmpty is false (replace with empty string)
    // Escape special regex characters in placeholder (especially . which is common in member.field patterns)
    const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    if (value !== null && value !== undefined) {
      // Replace both {{placeholder}} and [[placeholder]] syntax
      result = result.replace(new RegExp(`\\{\\{${escapedPlaceholder}\\}\\}`, 'g'), String(value));
      result = result.replace(new RegExp(`\\[\\[${escapedPlaceholder}\\]\\]`, 'g'), String(value));
    } else if (!preserveEmpty) {
      // Replace with empty string only if preserveEmpty is false
      result = result.replace(new RegExp(`\\{\\{${escapedPlaceholder}\\}\\}`, 'g'), '');
      result = result.replace(new RegExp(`\\[\\[${escapedPlaceholder}\\]\\]`, 'g'), '');
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
    .select('*')
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

async function buildActionSummary(action, tenantId, entityContext) {
  const summary = { type: action.type };
  const cfg = action.config || {};

  switch (action.type) {
    case 'update_field': {
      const fieldType = cfg.field_type?.replace(/^(org_|member_|job_posting_)/, '') || cfg.field_type;
      let valueLabel = cfg.value;
      if (cfg.value === '{{current_date}}') valueLabel = 'Current date (when workflow runs)';
      else if (cfg.value === '{{current_datetime}}') valueLabel = 'Current date & time';
      let fieldLabel = cfg.field_label;
      if (!fieldLabel && cfg.field_id && tenantId) {
        try {
          const { data: prefField } = await supabase
            .from('preference_field')
            .select('label')
            .eq('id', cfg.field_id)
            .eq('tenant_id', tenantId)
            .maybeSingle();
          if (prefField?.label) fieldLabel = prefField.label;
        } catch (e) {}
      }
      if (!fieldLabel) fieldLabel = cfg.field_id || 'field';
      summary.description = 'Update field value';
      summary.detail = `Set "${fieldLabel}" to "${valueLabel || ''}"`;
      summary.field_label = fieldLabel;
      summary.field_type = fieldType;
      summary.value_label = valueLabel;
      break;
    }
    case 'send_email': {
      summary.description = 'Send email notification';
      if (cfg.mode === 'template' && cfg.template_name) {
        summary.detail = `Send email using template "${cfg.template_name}"`;
      } else if (cfg.subject) {
        summary.detail = `Send email: "${cfg.subject}"`;
      } else {
        summary.detail = 'Send email notification';
      }
      if (cfg.to_mode === 'role') summary.detail += ' (to role members)';
      break;
    }
    case 'create_membership': {
      summary.description = cfg.dry_run ? 'Simulate membership calculation (dry run)' : 'Create membership record';
      summary.detail = cfg.dry_run
        ? 'Calculate membership tier, discounts, and cost without creating a record'
        : 'Determine tier band, apply discounts, and create the membership history record';
      summary.dry_run = !!cfg.dry_run;

      if (!cfg.dry_run && tenantId && entityContext) {
        try {
          const { data: approvalSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'membership_require_approval')
            .eq('tenant_id', tenantId)
            .maybeSingle();

          if (approvalSetting?.setting_value === 'true') {
            summary.requires_approval = true;
            let orgId = null;
            if (entityContext.entityType === 'organization') {
              orgId = entityContext.entityId;
            } else if (entityContext.entityType === 'member' && entityContext.entityData?.organization_id) {
              orgId = entityContext.entityData.organization_id;
            }

            if (orgId) {
              const simResult = await simulateMembershipForOrg(tenantId, orgId, { source: 'preview' });
              const yearLabel = simResult?.membershipYear?.label;

              if (yearLabel) {
                const { data: approvalRecord, error: approvalError } = await supabase
                  .from('organisation_membership_invoicing')
                  .select('fees_approved')
                  .eq('tenant_id', tenantId)
                  .eq('organization_id', orgId)
                  .eq('membership_year', yearLabel)
                  .maybeSingle();

                if (approvalError) {
                  console.error('[Workflows] Error querying fee approval in preview:', approvalError.message);
                }

                // Task #3241 — the config's "Auto-approve fees" setting means
                // execution will approve and proceed; preview stays read-only.
                summary.fees_approved = !!approvalRecord?.fees_approved || !!simResult?.config?.auto_approve_fees;
                summary.membership_year = yearLabel;
                if (!summary.fees_approved) {
                  summary.approval_warning = `Fees for ${yearLabel} have not been approved`;
                }
              }
            } else if (entityContext.entityType === 'member' && entityContext.entityId) {
              // Task #3237 — mirror the member-scoped execution path
              // (executeCreateMemberMembership): a member without an
              // organisation may be covered by a member-driven tier
              // structure; show their real fee-approval state instead of
              // the misleading "organisation could not be determined".
              let memberConfig = null;
              try {
                memberConfig = await getConfigForMember(tenantId, entityContext.entityId);
              } catch (cfgErr) {
                console.error('[Workflows] Preview member-config resolution failed:', cfgErr.message);
              }

              if (memberConfig) {
                const simResult = await simulateMembershipForMember(tenantId, entityContext.entityId, {
                  source: 'preview',
                  mode: 'manual',
                });
                const yearLabel = simResult?.membershipYear?.label;

                if (yearLabel) {
                  const { data: approvalRecord, error: approvalError } = await supabase
                    .from('member_membership_invoicing')
                    .select('fees_approved')
                    .eq('tenant_id', tenantId)
                    .eq('member_id', entityContext.entityId)
                    .eq('membership_year', yearLabel)
                    .maybeSingle();

                  if (approvalError) {
                    console.error('[Workflows] Error querying member fee approval in preview:', approvalError.message);
                  }

                  const memberName = simResult?.member?.name || 'this member';
                  // Task #3241 — auto-approve on the config counts as approved
                  // (execution materialises it); preview stays read-only.
                  summary.fees_approved = !!approvalRecord?.fees_approved || !!memberConfig.auto_approve_fees;
                  summary.membership_year = yearLabel;
                  if (!summary.fees_approved) {
                    summary.approval_warning = `Fees for ${yearLabel} have not been approved for ${memberName}`;
                  }
                } else {
                  summary.approval_warning = 'Fee approval is required but the membership year could not be determined';
                }
              } else {
                summary.approval_warning = 'Fee approval is required but organisation could not be determined';
              }
            } else {
              summary.approval_warning = 'Fee approval is required but organisation could not be determined';
            }
          }
        } catch (e) {
          console.error('[Workflows] Error checking approval in buildActionSummary:', e.message);
        }
      }
      break;
    }
    case 'create_contract': {
      summary.description = 'Create contract';
      summary.detail = cfg.contract_form_name
        ? `Create contract from form "${cfg.contract_form_name}"`
        : 'Create contract from form template';
      break;
    }
    default:
      summary.description = action.type?.replace(/_/g, ' ') || 'Unknown action';
      summary.detail = '';
  }

  return summary;
}

const CORE_FIELD_LABELS = {
  member: {
    id: 'ID', email: 'Email', first_name: 'First Name', last_name: 'Last Name',
    full_name: 'Full Name', phone: 'Phone', mobile: 'Mobile', landline: 'Landline',
    job_title: 'Job Title', status: 'Status', organization_id: 'Organisation ID',
    role_id: 'Role ID', biography: 'Biography', profile_photo_url: 'Profile Photo URL',
    show_in_directory: 'Show in Directory', is_admin: 'Is Admin', login_enabled: 'Login Enabled',
  },
  organization: {
    id: 'ID', name: 'Name', status: 'Status', phone: 'Phone',
    invoicing_email: 'Invoicing Email', invoicing_address: 'Invoicing Address',
    website_url: 'Website URL', training_fund_balance: 'Training Fund Balance',
    address_line_1: 'Address Line 1', address_line_2: 'Address Line 2',
    city: 'City', region: 'Region', postcode: 'Postcode', country: 'Country',
    description: 'Description', logo_url: 'Logo URL', account_owner_id: 'Account Owner ID',
  },
  job_posting: {
    id: 'ID', title: 'Job Title', status: 'Status', company_name: 'Company Name',
    contact_email: 'Contact Email', contact_name: 'Contact Name', location: 'Location',
    job_type: 'Job Type', hours: 'Hours', salary_range: 'Salary Range',
    is_member_post: 'Is Member Post', payment_status: 'Payment Status',
    featured: 'Featured', closing_date: 'Closing Date', expiry_date: 'Expiry Date',
  },
};

const OPERATOR_LABELS = {
  equals: 'equals', not_equals: 'does not equal', contains: 'contains',
  not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  is_empty: 'is empty', is_not_empty: 'is not empty', changed_to: 'changed to',
  changed_from: 'changed from',
};

async function buildConditionSummaries(conditions, tenantId, entityType) {
  if (!conditions || conditions.length === 0) return [];
  
  const summaries = [];
  for (const condition of conditions) {
    const fieldType = condition.field_type || 'core';
    let fieldLabel = null;
    
    const isCustom = fieldType === 'custom' || fieldType === 'member_custom' || fieldType === 'org_custom' || fieldType === 'job_posting_custom';
    
    if (isCustom && condition.field_id && tenantId) {
      try {
        const { data: prefField } = await supabase
          .from('preference_field')
          .select('label')
          .eq('id', condition.field_id)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (prefField?.label) fieldLabel = prefField.label;
      } catch (e) {}
    }
    
    if (!fieldLabel) {
      const coreEntity = fieldType === 'org_core' ? 'organization'
        : fieldType === 'job_posting_core' ? 'job_posting'
        : fieldType === 'member_core' ? 'member'
        : entityType;
      fieldLabel = CORE_FIELD_LABELS[coreEntity]?.[condition.field_id] || condition.field_id;
    }
    
    summaries.push({
      field_id: condition.field_id,
      field_type: fieldType,
      field_label: fieldLabel,
      operator: condition.operator,
      operator_label: OPERATOR_LABELS[condition.operator] || condition.operator,
      value: condition.value,
      logic: condition.logic || 'AND',
    });
  }
  return summaries;
}

// Task #3232 — workflow-set fields trigger downstream workflows.
// A chain context rides on `context.chain`: { depth, visited: [workflowIds] }.
// Each update_field action extends the chain with the CURRENT workflow's id
// before re-evaluating field-change workflows, so a workflow never re-triggers
// itself and A -> B -> A cycles stop at the visited guard. Depth is capped as
// a belt-and-braces backstop for long non-cyclic chains.
const MAX_WORKFLOW_CHAIN_DEPTH = 5;

const FINAL_ATTENDANCE_RESULTS = new Set(['attended', 'below_threshold', 'absent']);

// Attendance transitions are produced by the attendance outbox, rather than a
// request body. Keep the condition surface explicit: this prevents unrelated
// keys in provider metadata from becoming workflow condition values.
const ATTENDANCE_CONDITION_FIELDS = new Set([
  'outcome', 'status', 'duration_seconds', 'duration_minutes',
  'threshold_minutes', 'provider', 'target_type', 'target_id',
  'attendance_outcome', 'attendance_status', 'attendance_duration_seconds',
  'attendance_duration_minutes', 'attendance_threshold_minutes',
  'attendance_provider', 'attendance_revision_id', 'attendance_revision_number',
  'attendance_target_id', 'attendance_target_type', 'attendance_target_record_id',
  'event_id', 'booking_id', 'booking_type', 'member_id', 'attendee_id',
  'attendee_email', 'attendee_name', 'ticket_id', 'ticket_name', 'ticket_type',
  'booking_reference', 'event_name', 'target_name',
  'provider_target_id', 'provider_target_type',
]);

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

/**
 * Convert the provider-neutral attendance outbox contract to the small,
 * trusted condition context understood by the workflow runtime. Both
 * snake_case (database rows) and camelCase (service objects) are accepted so
 * recovery workers can pass their claimed row without reshaping it.
 */
export function normalizeAttendanceResultTransition(transition) {
  const source = transition?.payload && typeof transition.payload === 'object'
    ? { ...transition.payload, ...transition }
    : transition;
  if (!source || typeof source !== 'object') {
    throw new Error('attendance result transition is required');
  }

  const outcome = String(firstDefined(
    source.outcome, source.status?.current, source.status, source.attendance_outcome, source.attendanceStatus,
  ) || '').toLowerCase();
  const transitionId = firstDefined(source.transition_id, source.transitionId, source.id);
  const tenantId = firstDefined(source.tenant_id, source.tenantId);
  const bookingId = firstDefined(source.booking_id, source.bookingId, source.booking?.id);
  const targetId = firstDefined(
    source.attendance_target_id, source.attendanceTargetId,
    source.target?.attendance_target_id, source.target?.id,
  );
  const revisionId = firstDefined(
    source.outcome_revision_id, source.outcomeRevisionId, source.revision_id,
    source.revisionId, source.revision?.id,
  );

  if (!transitionId) throw new Error('attendance result transition id is required');
  if (!tenantId) throw new Error('attendance result transition tenant_id is required');
  if (!bookingId) throw new Error('attendance result transition booking_id is required');
  if (!targetId) throw new Error('attendance result transition attendance_target_id is required');
  if (!revisionId) throw new Error('attendance result transition outcome_revision_id is required');
  if (!FINAL_ATTENDANCE_RESULTS.has(outcome)) {
    throw new Error(`attendance result transition has non-final outcome "${outcome || 'missing'}"`);
  }

  const durationSeconds = Number(firstDefined(
    source.duration_seconds, source.durationSeconds, source.attendance_duration_seconds, 0,
  ));
  const thresholdMinutes = Number(firstDefined(
    source.threshold_minutes, source.thresholdMinutes, source.attendance_threshold_minutes, 0,
  ));
  const memberId = firstDefined(
    source.member_id, source.memberId, source.member?.id,
    source.attendee?.member_id, source.attendee?.memberId,
  );
  const attendeeId = firstDefined(
    source.attendee_id, source.attendeeId, source.attendee?.id, memberId,
  );
  const targetType = firstDefined(
    source.target_type, source.targetType, source.target?.type,
  );
  const targetRecordId = firstDefined(
    source.target_id, source.targetId, source.target?.id,
  );

  const conditionContext = {
    outcome,
    status: outcome,
    duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    duration_minutes: Number.isFinite(durationSeconds) ? durationSeconds / 60 : 0,
    threshold_minutes: Number.isFinite(thresholdMinutes) ? thresholdMinutes : 0,
    provider: firstDefined(source.provider, source.attendance_provider),
    target_type: targetType,
    target_id: targetRecordId,
    attendance_outcome: outcome,
    attendance_status: outcome,
    attendance_duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    attendance_duration_minutes: Number.isFinite(durationSeconds) ? durationSeconds / 60 : 0,
    attendance_threshold_minutes: Number.isFinite(thresholdMinutes) ? thresholdMinutes : 0,
    attendance_provider: firstDefined(source.provider, source.attendance_provider),
    attendance_revision_id: revisionId,
    attendance_revision_number: firstDefined(
      source.revision_number, source.revisionNumber, source.revision?.number,
      typeof source.revision === 'number' ? source.revision : undefined,
    ),
    attendance_target_id: targetId,
    attendance_target_type: targetType,
    attendance_target_record_id: targetRecordId,
    event_id: firstDefined(source.event_id, source.eventId, source.event?.id, source.target?.event_id),
    booking_id: bookingId,
    booking_type: firstDefined(source.booking_type, source.bookingType, source.booking?.type),
    member_id: memberId,
    attendee_id: attendeeId,
    attendee_email: firstDefined(source.attendee_email, source.attendeeEmail, source.attendee?.email),
    attendee_name: firstDefined(source.attendee_name, source.attendeeName, source.attendee?.name),
    ticket_id: firstDefined(source.ticket_id, source.ticketId, source.ticket?.id),
    ticket_name: firstDefined(source.ticket_name, source.ticketName, source.ticket?.name),
    ticket_type: firstDefined(source.ticket_type, source.ticketType, source.ticket?.type),
    booking_reference: firstDefined(source.booking_reference, source.bookingReference, source.booking?.reference),
    event_name: firstDefined(source.event_name, source.eventName, source.event?.name, source.event?.title),
    target_name: firstDefined(source.target_name, source.targetName, source.target?.name, source.target?.title),
    provider_target_id: firstDefined(
      source.provider_target_id, source.providerTargetId, source.target?.provider_target_id,
    ),
    provider_target_type: firstDefined(
      source.provider_target_type, source.providerTargetType, source.target?.provider_target_type,
    ),
  };

  // Undefined values are deliberately omitted from logs and template data.
  for (const [key, value] of Object.entries(conditionContext)) {
    if (value === undefined || value === null) delete conditionContext[key];
  }

  return {
    transitionId: String(transitionId),
    tenantId: String(tenantId),
    bookingId: String(bookingId),
    targetId: String(targetId),
    revisionId: String(revisionId),
    outcome,
    memberId: memberId ? String(memberId) : null,
    conditionContext,
  };
}

export function attendanceTriggerMatches(triggerConfig = {}, attendanceContext = {}) {
  const expectedOutcomes = firstDefined(
    triggerConfig.outcomes, triggerConfig.statuses, triggerConfig.outcome, triggerConfig.status,
  );
  const outcomes = Array.isArray(expectedOutcomes) ? expectedOutcomes : [expectedOutcomes];
  if (expectedOutcomes !== undefined && expectedOutcomes !== null && outcomes.length > 0) {
    if (!outcomes.map(value => String(value).toLowerCase()).includes(attendanceContext.attendance_outcome)) {
      return false;
    }
  }
  const scopedFields = [
    ['provider', 'provider'],
    ['event_id', 'event_id'],
    ['attendance_target_id', 'attendance_target_id'],
    ['target_type', 'target_type'],
    ['target_id', 'target_id'],
    ['session_id', 'target_id'],
    ['agenda_item_id', 'target_id'],
  ];
  return scopedFields.every(([configField, contextField]) => {
    const expected = triggerConfig[configField];
    if ((configField === 'session_id' || configField === 'agenda_item_id') && expected) {
      const requiredType = configField === 'session_id' ? 'complex_event_session' : 'agenda_item';
      if (attendanceContext.target_type !== requiredType) return false;
    }
    return expected === undefined || expected === null || expected === ''
      || String(expected) === String(attendanceContext[contextField] ?? '');
  });
}

export function isAttendanceConditionField(fieldType, fieldId) {
  return (fieldType === 'attendance' || fieldType === 'attendance_result')
    && ATTENDANCE_CONDITION_FIELDS.has(fieldId);
}

export function extendWorkflowChain(context, workflow) {
  const prev = context?.chain || {};
  const visited = new Set(prev.visited || []);
  visited.add(workflow.id);
  const depth = (prev.depth || 0) + 1;
  if (depth > MAX_WORKFLOW_CHAIN_DEPTH) return null;
  return { depth, visited: Array.from(visited) };
}

export function buildChainedWorkflowContext(context, additions = {}) {
  const {
    deliveryKey: _deliveryKey,
    actionEntityId: _actionEntityId,
    attendance: _attendance,
    triggerData: _triggerData,
    ...rest
  } = context || {};
  return { ...rest, ...additions };
}

export function attendanceWorkflowDeliveryKey({
  tenantId,
  workflowId,
  entityId,
  triggerMode,
  transitionDeliveryKey,
}) {
  return triggerMode === 'once_per_record'
    ? `attendance-once:${tenantId}:${workflowId}:${entityId}`
    : `${transitionDeliveryKey}:workflow:${workflowId}`;
}

// Log a skipped run when the chain guard stops a downstream workflow, so the
// admin can see WHY it didn't fire instead of the skip living only in logs.
async function logChainGuardSkip(workflow, entityType, entityId, reason, chain) {
  try {
    await supabase.from('workflow_log').insert({
      tenant_id: workflow.tenant_id,
      workflow_id: workflow.id,
      entity_type: entityType,
      entity_id: entityId,
      trigger_data: {
        trigger_type: 'field_change',
        reason,
        chain_depth: chain?.depth,
        chain_visited: chain?.visited,
      },
      actions_executed: [],
      status: 'skipped',
    });
  } catch (e) {
    console.error(`[Workflows] Failed to log chain-guard skip for ${workflow.name}:`, e.message);
  }
}

async function executeWorkflowActions(workflow, entityType, entityId, entityData, baseUrl, context = {}) {
  const results = [];
  const tenantId = workflow.tenant_id;
  const formSubmissionId = context?.formSubmissionId || null;
  
  if (entityData && (entityData.first_name || entityData.last_name)) {
    entityData.recipient_name = `${entityData.first_name || ''} ${entityData.last_name || ''}`.trim();
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const action of (workflow.actions || [])) {
    // A guest attendance booking can receive communications, but it has no
    // member row that record-mutating actions can safely update.
    if (context?.attendance && !context?.actionEntityId
      && ['update_field', 'create_contract', 'create_membership'].includes(action.type)) {
      results.push({
        action_type: action.type,
        status: 'skipped',
        error: 'This attendance booking is not linked to a member record',
      });
      continue;
    }

    // Normalize prefixed field types (e.g., job_posting_core -> core)
    let normalizedFieldType = action.config?.field_type?.replace(/^(org_|member_|job_posting_)/, '') || action.config?.field_type;
    
    if (action.type === 'update_field' && normalizedFieldType === 'core' && UUID_REGEX.test(action.config?.field_id)) {
      console.log(`[Workflows] update_field: field_id "${action.config.field_id}" is a UUID, reclassifying from core to custom for ${entityType}`);
      normalizedFieldType = 'custom';
    }

    if (action.type === 'update_field' && normalizedFieldType === 'core') {
      let table;
      if (entityType === 'organization') {
        table = 'organization';
      } else if (entityType === 'job_posting') {
        table = 'job_posting';
      } else {
        table = 'member';
      }
      // Training fund balances must only change through ledger-writing
      // paths (RPCs / the admin adjust endpoint). Skip defensively for any
      // legacy workflow configs that still reference them.
      if (table === 'organization' && isProtectedOrgBalanceField(action.config?.field_id)) {
        console.warn(`[Workflows] update_field (core): "${action.config.field_id}" is a protected ledger-backed field - skipping`);
        results.push({ action_type: 'update_field', field_type: 'core', status: 'skipped', error: `Field "${action.config.field_id}" cannot be set by workflows (ledger-backed balance)` });
        continue;
      }
      let resolvedValue = action.config.value;
      if (resolvedValue === '{{current_date}}') {
        const now = new Date();
        resolvedValue = now.toISOString().split('T')[0];
      } else if (resolvedValue === '{{current_datetime}}') {
        resolvedValue = new Date().toISOString();
      }
      console.log(`[Workflows] update_field (core): ${table}.${action.config.field_id} = "${resolvedValue}" for ${entityType}:${entityId}`);
      // Task #3232: snapshot the row before writing so downstream field-change
      // workflows can be evaluated with real before/after data.
      let beforeRow = null;
      try {
        const { data } = await supabase.from(table).select('*').eq('id', entityId).maybeSingle();
        beforeRow = data;
      } catch (e) {
        console.warn(`[Workflows] update_field (core): before-row snapshot failed:`, e.message);
      }
      const { data: updateData, error: updateError } = await supabase.from(table).update({ [action.config.field_id]: resolvedValue }).eq('id', entityId).select('id');
      if (updateError) {
        console.error(`[Workflows] update_field (core) error:`, updateError.message);
        results.push({ action_type: 'update_field', field_type: 'core', status: 'failed', error: updateError.message });
      } else if (!updateData || updateData.length === 0) {
        console.warn(`[Workflows] update_field (core): 0 rows updated for ${table}.${action.config.field_id} on entity ${entityId}`);
        results.push({ action_type: 'update_field', field_type: 'core', status: 'failed', error: `No rows updated - field "${action.config.field_id}" may not exist on ${table}` });
      } else {
        results.push({ action_type: 'update_field', field_type: 'core', status: 'success' });
        // Task #3232: a workflow-set field must evaluate downstream workflows
        // itself (nothing else sees this write). System-initiated, so
        // requires_confirmation workflows run without the popup.
        const beforeValue = String(beforeRow?.[action.config.field_id] ?? '');
        const afterValue = String(resolvedValue ?? '');
        if (beforeValue !== afterValue) {
          const chain = extendWorkflowChain(context, workflow);
          if (!chain) {
            console.warn(`[Workflows] Chain depth cap (${MAX_WORKFLOW_CHAIN_DEPTH}) reached after "${workflow.name}" - not evaluating downstream workflows for ${table}.${action.config.field_id}`);
            await logChainGuardSkip(workflow, entityType, entityId, 'chain_depth_cap', context?.chain);
          } else {
            try {
              const afterRow = { ...(beforeRow || {}), id: entityId, [action.config.field_id]: resolvedValue };
              await triggerWorkflows(entityType, entityId, beforeRow || {}, afterRow, 'field_change', baseUrl, buildChainedWorkflowContext(context, {
                systemInitiated: true,
                // Task #3235: record WHICH workflow started the chained run so
                // the history badge can name it, not just flag it as chained.
                triggeredByWorkflow: { id: workflow.id, name: workflow.name },
                chain,
              }));
            } catch (chainErr) {
              console.error(`[Workflows] Downstream evaluation after update_field (core) failed:`, chainErr.message);
            }
          }
        }
      }
    } else if (action.type === 'update_field' && normalizedFieldType === 'custom') {
      try {
        let prefTable, foreignKey;
        if (entityType === 'organization') {
          prefTable = 'organization_preference_value';
          foreignKey = 'organization_id';
        } else if (entityType === 'member') {
          prefTable = 'member_preference_value';
          foreignKey = 'member_id';
        } else if (entityType === 'job_posting') {
          prefTable = 'job_posting_preference_value';
          foreignKey = 'job_posting_id';
        } else {
          console.warn(`[Workflows] update_field (custom): unsupported entity type "${entityType}"`);
          results.push({ action_type: 'update_field', field_type: 'custom', status: 'failed', error: `Unsupported entity type "${entityType}" for custom field update` });
          continue;
        }

        const fieldId = action.config.field_id;

        let resolvedValue = action.config.value;
        if (resolvedValue === '{{current_date}}') {
          resolvedValue = new Date().toISOString().split('T')[0];
        } else if (resolvedValue === '{{current_datetime}}') {
          resolvedValue = new Date().toISOString();
        }

        // Look up the target custom field's type so boolean/checkbox writes
        // are normalised to the canonical 'true'/'false' string that the UI
        // (and the rest of the system) reads. Without this, workflow-written
        // values like "1"/"yes"/"on"/"True" render as off in the new Switch
        // toggle on the organisation detail view.
        let prefFieldType = null;
        try {
          const { data: prefField } = await supabase
            .from('preference_field')
            .select('field_type')
            .eq('id', fieldId)
            .maybeSingle();
          prefFieldType = prefField?.field_type || null;
        } catch (e) {
          // Non-fatal: fall through with prefFieldType=null and write verbatim
          // (matches prior behaviour for unknown field types).
        }

        if (prefFieldType === 'boolean' || prefFieldType === 'checkbox') {
          const coerced = coerceBooleanPreferenceValue(resolvedValue);
          if (coerced === null) {
            console.warn(`[Workflows] update_field (custom): boolean value did not coerce for field ${fieldId}: ${JSON.stringify(resolvedValue)}`);
            results.push({
              action_type: 'update_field',
              field_type: 'custom',
              status: 'failed',
              error: `Boolean custom field value ${JSON.stringify(resolvedValue)} could not be coerced to true/false`,
            });
            continue;
          }
          resolvedValue = coerced;
        }

        console.log(`[Workflows] update_field (custom): ${prefTable}.${fieldId} = "${resolvedValue}" for ${entityType}:${entityId}`);

        const { data: existing } = await supabase
          .from(prefTable)
          .select('id, value')
          .eq(foreignKey, entityId)
          .eq('field_id', fieldId)
          .maybeSingle();
        const previousValue = existing?.value;

        if (existing) {
          const { error: upErr } = await supabase
            .from(prefTable)
            .update({ value: resolvedValue })
            .eq('id', existing.id);
          if (upErr) {
            console.error(`[Workflows] update_field (custom) update error:`, upErr.message);
            results.push({ action_type: 'update_field', field_type: 'custom', status: 'failed', error: upErr.message });
            continue;
          }
        } else {
          const { error: insErr } = await supabase
            .from(prefTable)
            .insert({
              [foreignKey]: entityId,
              field_id: fieldId,
              value: resolvedValue,
            });
          if (insErr) {
            console.error(`[Workflows] update_field (custom) insert error:`, insErr.message);
            results.push({ action_type: 'update_field', field_type: 'custom', status: 'failed', error: insErr.message });
            continue;
          }
        }

        results.push({ action_type: 'update_field', field_type: 'custom', status: 'success' });

        // Task #3232: chain downstream field-change workflows for the custom
        // field this workflow just set. System-initiated -> confirmation
        // popups are bypassed (nobody is present to click Confirm).
        if (String(previousValue ?? '') !== String(resolvedValue ?? '')) {
          const chain = extendWorkflowChain(context, workflow);
          if (!chain) {
            console.warn(`[Workflows] Chain depth cap (${MAX_WORKFLOW_CHAIN_DEPTH}) reached after "${workflow.name}" - not evaluating downstream workflows for custom field ${fieldId}`);
            await logChainGuardSkip(workflow, entityType, entityId, 'chain_depth_cap', context?.chain);
          } else if (entityType === 'member' || entityType === 'organization') {
            try {
              await triggerPreferenceWorkflows(entityType, entityId, fieldId, String(resolvedValue ?? ''), baseUrl, previousValue, {
                ...context,
                systemInitiated: true,
                // Task #3235: name the initiating workflow in trigger_data.
                triggeredByWorkflow: { id: workflow.id, name: workflow.name },
                chain,
              });
            } catch (chainErr) {
              console.error(`[Workflows] Downstream evaluation after update_field (custom) failed:`, chainErr.message);
            }
          }
        }
      } catch (err) {
        console.error(`[Workflows] update_field (custom) error:`, err.message);
        results.push({ action_type: 'update_field', field_type: 'custom', status: 'failed', error: err.message });
      }
    } else if (action.type === 'send_email') {
      console.log(`[Workflows] send_email action config:`, JSON.stringify(action.config, null, 2));
      
      // Check if this is a role-based email (send to all members with specific role(s))
      // Support both new array format (to_role_ids) and legacy single role (to_role_id)
      const toRoleIds = action.config?.to_role_ids || (action.config?.to_role_id ? [action.config.to_role_id] : []);
      if (action.config?.to_mode === 'role' && toRoleIds.length > 0) {
        const roleResults = await executeRoleBasedEmail(action, workflow, entityType, entityId, entityData, baseUrl, toRoleIds, context);
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
      
      console.log(`[Workflows] Before replacePlaceholders - entityType: "${entityType}", entityData keys: ${entityData ? Object.keys(entityData).join(', ') : 'null'}`);
      console.log(`[Workflows] entityData sample: ${entityData ? JSON.stringify({ first_name: entityData.first_name, last_name: entityData.last_name, email: entityData.email, name: entityData.name }) : 'null'}`);
      console.log(`[Workflows] Subject before: "${subject}"`);
      const prefContext = entityType === 'member' && entityId ? { tenantBaseUrl: baseUrl, tenantId, memberId: entityId } : null;
      subject = replacePlaceholders(subject, entityType, entityData, prefContext);
      body = replacePlaceholders(body, entityType, entityData, prefContext);
      console.log(`[Workflows] Subject after: "${subject}"`);
      console.log(`[Workflows] Body after (first 500 chars): "${body?.substring(0, 500)}"`)
      
      // Process special placeholders like {{set_password_url}}
      console.log(`[Workflows] baseUrl: "${baseUrl}", entityType: "${entityType}", entityId: "${entityId}"`);
      console.log(`[Workflows] Body contains set_password_url: ${body?.includes('set_password_url')}`);
      // Task #3253 — background/webhook callers may not have a request host;
      // derive the tenant base URL from its slug so special placeholders
      // (e.g. {{set_password_url}}) still resolve.
      let effectiveBaseUrl = baseUrl;
      if (!effectiveBaseUrl && hasSetPasswordToken(subject, body)) {
        effectiveBaseUrl = await resolveWorkflowBaseUrl(baseUrl, tenantId);
      }
      if (effectiveBaseUrl) {
        if (entityType === 'member') {
          // Direct member trigger - use the entity ID
          subject = await processSpecialPlaceholders(subject, 'member', entityId, effectiveBaseUrl);
          body = await processSpecialPlaceholders(body, 'member', entityId, effectiveBaseUrl);
        } else if ((body?.includes('set_password_url') || subject?.includes('set_password_url')) && to) {
          // Non-member trigger but template has set_password_url - look up member by recipient email
          console.log(`[Workflows] Non-member trigger has set_password_url placeholder, looking up member by email: "${to}"`);
          const { data: recipientMember } = await supabase
            .from('member')
            .select('id')
            .eq('email', to.trim().toLowerCase())
            .eq('tenant_id', tenantId)
            .single();
          if (recipientMember) {
            console.log(`[Workflows] Found member ${recipientMember.id} for email ${to}, processing special placeholders`);
            subject = await processSpecialPlaceholders(subject, 'member', recipientMember.id, effectiveBaseUrl);
            body = await processSpecialPlaceholders(body, 'member', recipientMember.id, effectiveBaseUrl);
          } else {
            console.warn(`[Workflows] Could not find member for email "${to}" in tenant ${tenantId} - cannot generate set_password_url`);
            // Clean up the placeholder to avoid raw text in email
            subject = subject?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '').replace(/\[\[\s*set_password_url\s*\]\]/gi, '');
            body = body?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '').replace(/\[\[\s*set_password_url\s*\]\]/gi, '');
          }
        } else {
          // No special placeholders to process for non-member entities
          subject = await processSpecialPlaceholders(subject, entityType, entityId, effectiveBaseUrl);
          body = await processSpecialPlaceholders(body, entityType, entityId, effectiveBaseUrl);
        }
      } else {
        console.warn(`[Workflows] baseUrl is empty/undefined, cannot process special placeholders`);
      }
      
      console.log(`[Workflows] Sending email - to: "${to}", subject: "${subject}", body length: ${body?.length}`);
      if (cc) console.log(`[Workflows] CC: "${cc}"`);
      if (bcc) console.log(`[Workflows] BCC: "${bcc}"`);
      
      // Resolve dd_owner placeholders against the originating form submission
      // (passed via context.formSubmissionId by the form processor). When no
      // submission context is available, this collapses placeholders to empty
      // strings so they don't leak as raw text.
      const ddOwnerVals = await resolveDdOwnerForSubmission({ tenantId, formSubmissionId });
      subject = applyDdOwnerPlaceholders(subject, ddOwnerVals);
      body = applyDdOwnerPlaceholders(body, ddOwnerVals);

      // Task #3253 — final safety net: a raw set_password_url token must
      // never reach a recipient.
      subject = stripUnresolvedSetPasswordToken(subject, 'subject');
      body = stripUnresolvedSetPasswordToken(body, 'body');

      const inboxDelivery = await buildInboxDelivery({
        tenantId,
        memberId: entityType === 'member' ? entityId : null,
        email: to,
        labelKey: 'automations',
      });
      const emailResult = await sendEmail({ to, subject, html: body, from: fromEmail, replyTo, cc, bcc, tenantId, inboxDelivery });
      console.log(`[Workflows] Email result:`, JSON.stringify(emailResult));
      
      results.push({ 
        action_type: 'send_email', 
        status: emailResult.success ? 'success' : 'failed',
        messageId: emailResult.messageId,
        error: emailResult.error,
        template_id: action.config?.template_id
      });
    } else if (action.type === 'create_contract') {
      const contractResult = await executeCreateContractAction(action, workflow, entityType, entityId, entityData, baseUrl, context);
      results.push(contractResult);
    } else if (action.type === 'create_membership') {
      // A zero-due membership fires the paid transition immediately after its
      // durable insert. Do not let that nested paid event invoke another
      // create-membership action; other actions on the paid workflow still run.
      if (typeof context?.source === 'string' && context.source.endsWith('_zero_due')) {
        results.push({
          action_type: 'create_membership',
          status: 'skipped',
          message: 'Membership creation skipped for the zero-due paid transition',
        });
      } else {
        const membershipResult = await executeCreateMembershipAction(action, workflow, entityType, entityId, entityData);
        results.push(membershipResult);
      }
    }
  }
  
  return results;
}

async function executeCreateContractAction(action, workflow, entityType, entityId, entityData, baseUrl, context = {}) {
  const tenantId = workflow.tenant_id;
  console.log(`[Workflows] Executing create_contract action for entity ${entityType}:${entityId}`);
  
  try {
    const contractFormId = action.config?.contract_form_id;
    if (!contractFormId) {
      return { action_type: 'create_contract', status: 'failed', error: 'No contract template specified' };
    }
    
    const { data: contractForm, error: formError } = await supabase
      .from('form')
      .select('*')
      .eq('id', contractFormId)
      .eq('tenant_id', tenantId)
      .single();
    
    if (formError || !contractForm) {
      console.error('[Workflows] Contract form not found:', formError);
      return { action_type: 'create_contract', status: 'failed', error: 'Contract template not found' };
    }
    
    let organizationId = null;
    const orgMapping = action.config?.organization_mapping || '_trigger';
    
    if (orgMapping === '_trigger' && entityType === 'organization') {
      organizationId = entityId;
    } else if (orgMapping === '_trigger_org_id' && entityData?.organization_id) {
      organizationId = entityData.organization_id;
    } else if (orgMapping === '_member_org' && entityType === 'member') {
      organizationId = entityData?.organization_id;
    } else if (orgMapping?.startsWith('static:')) {
      organizationId = orgMapping.replace('static:', '');
    }
    
    console.log(`[Workflows] Resolved organization_id: ${organizationId}`);
    
    const signerMappings = action.config?.signer_mappings || [];
    const resolvedSigners = [];
    
    for (let i = 0; i < signerMappings.length; i++) {
      const mapping = signerMappings[i];
      const signer = {
        id: `signer_${Date.now()}_${i}`,
        type: 'external',
        name: '',
        email: '',
        signed: false,
        signed_at: null
      };
      
      let firstName = '';
      if (mapping.first_name_field === '_static') {
        firstName = mapping.first_name_static || '';
      } else if (mapping.first_name_field?.startsWith('core:')) {
        const fieldId = mapping.first_name_field.replace('core:', '');
        firstName = entityData?.[fieldId] || '';
      }
      
      let lastName = '';
      if (mapping.last_name_field === '_static') {
        lastName = mapping.last_name_static || '';
      } else if (mapping.last_name_field?.startsWith('core:')) {
        const fieldId = mapping.last_name_field.replace('core:', '');
        lastName = entityData?.[fieldId] || '';
      }
      
      signer.name = `${firstName} ${lastName}`.trim();
      
      if (mapping.email_field === '_static') {
        signer.email = mapping.email_static || '';
      } else if (mapping.email_field?.startsWith('core:')) {
        const fieldId = mapping.email_field.replace('core:', '');
        signer.email = entityData?.[fieldId] || '';
      }
      
      if (signer.email) {
        resolvedSigners.push(signer);
      } else {
        console.warn(`[Workflows] Signer ${i + 1} has no email, skipping`);
      }
    }
    
    console.log(`[Workflows] Resolved ${resolvedSigners.length} signers`);
    
    const sendForSigning = action.config?.send_for_signing !== false;
    
    const contractInstance = {
      tenant_id: tenantId,
      form_id: contractFormId,
      organization_id: organizationId,
      signers: resolvedSigners,
      status: sendForSigning ? 'out_for_signing' : 'draft',
      timeout_days: contractForm.contract_settings?.timeout_days || 30,
      created_from_workflow_id: workflow.id,
      created_from_entity_type: entityType,
      created_from_entity_id: entityId,
      sent_at: sendForSigning ? new Date().toISOString() : null,
      created_at: new Date().toISOString()
    };
    
    const { data: insertedInstance, error: insertError } = await supabase
      .from('contract_instance')
      .insert(contractInstance)
      .select()
      .single();
    
    if (insertError) {
      console.error('[Workflows] Error creating contract instance:', insertError);
      if (insertError.code === '42P01') {
        console.error('[Workflows] contract_instance table does not exist. Please run the migration.');
        return { action_type: 'create_contract', status: 'failed', error: 'Contract instance table not set up. Please contact administrator.' };
      }
      return { action_type: 'create_contract', status: 'failed', error: 'Failed to create contract instance' };
    }
    
    console.log(`[Workflows] Created contract instance: ${insertedInstance.id}`);
    
    if (sendForSigning && resolvedSigners.length > 0) {
      const initialTemplateId = contractForm.contract_settings?.initial_email_template_id;
      
      if (initialTemplateId) {
        const { data: emailTemplate, error: templateError } = await supabase
          .from('email_template')
          .select('*')
          .eq('id', initialTemplateId)
          .single();
        
        if (emailTemplate && !templateError) {
          for (const signer of resolvedSigners) {
            const signingUrl = `${baseUrl}/form/${contractForm.slug}?contract_instance=${insertedInstance.id}&signer=${encodeURIComponent(signer.email)}`;
            
            let subject = emailTemplate.subject || 'Contract for Signing';
            let body = emailTemplate.body || '';
            
            subject = subject
              .replace(/\{\{signer_name\}\}/gi, signer.name)
              .replace(/\{\{signer_email\}\}/gi, signer.email)
              .replace(/\{\{contract_name\}\}/gi, contractForm.name)
              .replace(/\{\{sign_url\}\}/gi, signingUrl)
              .replace(/\{\{signing_url\}\}/gi, signingUrl)
              .replace(/\{\{sign_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`)
              .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);
            
            body = body
              .replace(/\{\{signer_name\}\}/gi, signer.name)
              .replace(/\{\{signer_email\}\}/gi, signer.email)
              .replace(/\{\{contract_name\}\}/gi, contractForm.name)
              .replace(/\{\{sign_url\}\}/gi, signingUrl)
              .replace(/\{\{signing_url\}\}/gi, signingUrl)
              .replace(/\{\{sign_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`)
              .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);
            
            body = replacePlaceholders(body, entityType, entityData, null);
            subject = replacePlaceholders(subject, entityType, entityData, null);

            // Resolve dd_owner placeholders against the originating form submission
            // (passed via context.formSubmissionId by the form processor). Falls
            // back to empty strings when no submission context is available.
            const ddOwnerVals = await resolveDdOwnerForSubmission({ tenantId, formSubmissionId: context?.formSubmissionId || null });
            subject = applyDdOwnerPlaceholders(subject, ddOwnerVals);
            body = applyDdOwnerPlaceholders(body, ddOwnerVals);

            // Resolve [[...]] bracket placeholders (e.g. [[organization.name]]).
            // replacePlaceholders only resolves org tokens when the trigger
            // entity IS the organization, so contracts triggered off other
            // entities would otherwise leak [[organization.name]] raw. Prefer
            // the resolved contract organization_id, falling back to the
            // originating submission's organization.
            const bracketPlaceholders = await buildContractBracketPlaceholders({
              tenantId,
              organizationId: organizationId || null,
              formSubmissionId: context?.formSubmissionId || null,
              signer,
              contractName: contractForm.name,
              ownerName: ddOwnerVals.ownerName,
            });
            subject = replaceContractBracketPlaceholders(subject, bracketPlaceholders);
            body = replaceContractBracketPlaceholders(body, bracketPlaceholders);

            console.log(`[Workflows] Sending signing invitation to ${signer.email}`);
            
            await sendEmail({
              to: signer.email,
              subject,
              html: body,
              from: emailTemplate.from_email,
              replyTo: emailTemplate.reply_to,
              tenantId
            });
          }
          
          console.log(`[Workflows] Sent signing invitations to ${resolvedSigners.length} signers`);
        } else {
          console.warn(`[Workflows] Initial email template not found: ${initialTemplateId}`);
        }
      } else {
        console.log(`[Workflows] No initial email template configured, contract instance created but not sent`);
      }
    }
    
    return {
      action_type: 'create_contract',
      status: 'success',
      contract_instance_id: insertedInstance.id,
      contract_form_id: contractFormId,
      organization_id: organizationId,
      signers_count: resolvedSigners.length,
      sent_for_signing: sendForSigning
    };
    
  } catch (error) {
    console.error('[Workflows] create_contract action error:', error);
    return { action_type: 'create_contract', status: 'failed', error: error.message };
  }
}

async function executeCreateMembershipAction(action, workflow, entityType, entityId, entityData) {
  const tenantId = workflow.tenant_id;
  console.log(`[Workflows] Executing create_membership action for entity ${entityType}:${entityId}`);

  try {
    let organizationId = null;
    if (entityType === 'organization') {
      organizationId = entityId;
    } else if (entityType === 'member') {
      organizationId = entityData?.organization_id;
      if (!organizationId) {
        const { data: member } = await supabase
          .from('member')
          .select('organization_id, tenant_id')
          .eq('id', entityId)
          .eq('tenant_id', tenantId)
          .single();
        organizationId = member?.organization_id;
      }

      // Task #3211 — structure-aware routing: when the triggering member is
      // covered by a member-driven tier structure (structure_scope_type =
      // 'member'), record the membership against the member, not their
      // organisation. Members WITH an organisation stay on the org path
      // (organisation-driven tiers), matching /api/membership/direct-debit.
      if (!organizationId) {
        let memberConfig = null;
        try {
          memberConfig = await getConfigForMember(tenantId, entityId);
        } catch (cfgErr) {
          console.error('[Workflows] create_membership member-config resolution failed:', cfgErr.message);
        }
        if (memberConfig) {
          return await executeCreateMemberMembership(action, workflow, entityId);
        }
      }
    }

    if (!organizationId) {
      return {
        action_type: 'create_membership',
        status: 'failed',
        error: entityType === 'member'
          ? 'Member has no organisation and no member-driven tier structure matches them'
          : 'Could not resolve organisation ID',
      };
    }

    const isDryRun = !!action.config?.dry_run;
    console.log(`[Workflows] ${isDryRun ? 'Dry run' : 'Live'} create_membership - using shared simulation`);

    const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
      source: 'workflow',
      workflowName: workflow.name,
    });

    if (!simResult.success) {
      return {
        action_type: 'create_membership',
        status: 'failed',
        error: simResult.error,
        simulation_steps: simResult.steps,
      };
    }

    if (isDryRun) {
      return {
        action_type: 'create_membership',
        status: 'dry_run',
        organization_name: simResult.org.name,
        tier_label: simResult.tierLabel,
        annual_cost: simResult.annualCost,
        final_cost: simResult.finalCost,
        membership_year: simResult.membershipYear.label,
        year_number: simResult.yearNumber,
        free_period_discount: simResult.freeDiscount,
        rollover_discount: simResult.rolloverDiscount,
        custom_discount_total: simResult.customDiscountTotal,
        prorata_cost: simResult.prorataCost,
        currency: simResult.currency,
        overrideApplied: simResult.overrideApplied,
        simulation_steps: simResult.steps,
      };
    }

    const targetYearLabel = simResult.membershipYear.label;
    const { data: invoicingSetting } = await supabase
      .from('organisation_membership_invoicing')
      .select('id, invoicing_mode, invoice_date')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', targetYearLabel)
      .maybeSingle();

    let fallbackSetting = null;
    if (!invoicingSetting) {
      const { data: legacySetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('id, invoicing_mode, invoice_date')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .is('membership_year', null)
        .maybeSingle();
      fallbackSetting = legacySetting;
    }

    const effectiveInvoicingMode = invoicingSetting?.invoicing_mode || fallbackSetting?.invoicing_mode || 'automatic';

    if (effectiveInvoicingMode === 'manual') {
      console.log(`[Workflows] Skipping create_membership for org ${organizationId} - invoicing mode is manual for ${targetYearLabel}`);
      return {
        action_type: 'create_membership',
        status: 'skipped',
        message: `Invoicing is set to manual for ${targetYearLabel}. Use the admin UI "Renew & Invoice Now" button to create the record.`,
      };
    }

    if (effectiveInvoicingMode === 'scheduled') {
      const invoiceDate = invoicingSetting?.invoice_date || fallbackSetting?.invoice_date || null;
      console.log(`[Workflows] Skipping create_membership for org ${organizationId} - invoicing mode is scheduled for ${targetYearLabel} (invoice date: ${invoiceDate})`);
      return {
        action_type: 'create_membership',
        status: 'skipped',
        message: `Invoicing is set to scheduled for ${targetYearLabel}${invoiceDate ? ` (invoice date: ${invoiceDate})` : ''}. The scheduled renewal job will process this automatically.`,
      };
    }

    try {
      const { data: approvalSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'membership_require_approval')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (approvalSetting?.setting_value === 'true') {
        const { data: approvalRecord, error: approvalError } = await supabase
          .from('organisation_membership_invoicing')
          .select('fees_approved')
          .eq('tenant_id', tenantId)
          .eq('organization_id', organizationId)
          .eq('membership_year', targetYearLabel)
          .maybeSingle();

        if (approvalError) {
          console.error(`[Workflows] Error checking fee approval for org ${organizationId}:`, approvalError.message);
        }

        if (!approvalRecord?.fees_approved) {
          // Task #3241 — the tier config's "Auto-approve fees" setting wins:
          // materialise the approval and proceed instead of skipping.
          const autoResult = await autoApproveOrgFees(tenantId, organizationId, {
            config: simResult.config,
            yearLabel: targetYearLabel,
          });
          if (!autoResult.approved) {
            console.log(`[Workflows] Skipping create_membership for org ${organizationId} - fees not approved for ${targetYearLabel}`);
            return {
              action_type: 'create_membership',
              status: 'skipped',
              message: `Fees for ${targetYearLabel} have not been approved. Approve fees on the Membership tab before the workflow can create a record.`,
            };
          }
        }
      }
    } catch (approvalErr) {
      console.error(`[Workflows] Fee approval check failed for org ${organizationId}:`, approvalErr.message);
    }

    const vatRate = simResult.matchedBand?.vat_rate !== null && simResult.matchedBand?.vat_rate !== undefined
      ? parseFloat(simResult.matchedBand.vat_rate)
      : null;

    // Add-on lines stored at fee-approval time are part of the amount due.
    // Load them before deciding that an otherwise-free membership is settled.
    let addonLines = [];
    let addonTotals = null;
    try {
      const { loadAddonLines, computeAddonTotals } = await import('./membershipAddons.js');
      addonLines = await loadAddonLines(tenantId, organizationId, targetYearLabel);
      addonTotals = computeAddonTotals(addonLines);
    } catch (addonErr) {
      console.error(`[Workflows] Failed to load add-on lines for org ${organizationId} (non-fatal):`, addonErr.message);
    }

    const zeroDue = isZeroDueMembership(simResult, addonTotals);
    const paidAt = zeroDue ? new Date().toISOString() : null;

    if (simResult.existingRecord) {
      const { data: existingRow, error: existingRowError } = await supabase
        .from('organisation_membership_history')
        .select('*')
        .eq('id', simResult.existingRecord.id)
        .maybeSingle();
      if (existingRowError) throw existingRowError;
      if (existingRow?.payment_status === 'paid' && isZeroDueExistingMembership(existingRow)) {
        const paidWorkflow = await fireNewZeroDueMembershipPaidWorkflow({
          table: 'organisation_membership_history',
          row: existingRow,
          paidAt: existingRow.paid_at,
          source: 'workflow_org_membership_zero_due',
        });
        return {
          action_type: 'create_membership',
          status: 'success',
          settled: true,
          already_processed: true,
          paid_workflow_fired: paidWorkflow?.fired === true,
          membership_id: existingRow.id,
        };
      }
      console.log(`[Workflows] Membership record for ${targetYearLabel} already exists for org ${organizationId}`);
      return { action_type: 'create_membership', status: 'skipped', message: `Membership record for ${targetYearLabel} already exists` };
    }

    const record = {
      tenant_id: tenantId,
      organization_id: organizationId,
      membership_year: simResult.membershipYear.label,
      config_id: simResult.config.id,
      band_id: simResult.matchedBand.id,
      tier_label: simResult.tierLabel,
      field_value: simResult.fieldValue,
      annual_cost: simResult.annualCost,
      prorata_cost: simResult.prorataCost,
      free_period_discount: simResult.freeDiscount,
      rollover_discount: simResult.rolloverDiscount,
      custom_discount_total: simResult.customDiscountTotal,
      custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
      final_cost: simResult.finalCost,
      currency: simResult.currency,
      billing_period: simResult.billingPeriod,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: simResult.totalWithVat || simResult.finalCost,
      year_number: simResult.yearNumber || null,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'active',
      notes: `Created by workflow "${workflow.name}" (year ${simResult.yearNumber})`,
      ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
    };

    if (vatRate !== null) {
      record.vat_rate = vatRate;
    }

    // A PO is provider metadata, so avoid reading it entirely for zero-due
    // rows. Positive paths retain the same stored reference behaviour.
    let poNumber = null;
    const effectiveInvoicingSetting = invoicingSetting || fallbackSetting;
    if (!zeroDue && effectiveInvoicingSetting?.id) {
      const { data: poSetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('purchase_order_number')
        .eq('id', effectiveInvoicingSetting.id)
        .maybeSingle();
      poNumber = poSetting?.purchase_order_number || null;
      record.purchase_order_number = poNumber;
    }
    if (addonLines.length > 0) {
      record.notes += `. ${addonLines.length} add-on line(s) invoiced.`;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('organisation_membership_history')
      .insert(record)
      .select()
      .single();

    if (insertError) {
      console.error('[Workflows] Error creating membership record:', insertError);
      return { action_type: 'create_membership', status: 'failed', error: insertError.message };
    }

    console.log(`[Workflows] Created membership record ${inserted.id} for org ${simResult.org.name} - tier: ${simResult.tierLabel}, final cost: ${simResult.finalCost}, year: ${simResult.membershipYear.label} (year number ${simResult.yearNumber})`);

    if (zeroDue) {
      // Reloading in the helper proves the paid state is durable. This call is
      // only reachable after a successful new insert, so the paid event fires
      // once and never for duplicate/failed inserts.
      const paidWorkflow = await fireNewZeroDueMembershipPaidWorkflow({
        table: 'organisation_membership_history',
        row: inserted,
        paidAt,
        source: 'workflow_org_membership_zero_due',
      });
      return {
        action_type: 'create_membership',
        status: 'success',
        settled: true,
        payment_status: 'paid',
        paid_at: paidAt,
        paid_workflow_fired: paidWorkflow?.fired === true,
        membership_id: inserted.id,
        organization_id: organizationId,
        organization_name: simResult.org.name,
        tier_label: simResult.tierLabel,
        annual_cost: simResult.annualCost,
        final_cost: simResult.finalCost,
        membership_year: targetYearLabel,
        year_number: simResult.yearNumber,
        free_period_discount: simResult.freeDiscount,
        rollover_discount: simResult.rolloverDiscount,
        custom_discount_total: simResult.customDiscountTotal,
        prorata_cost: simResult.prorataCost,
      };
    }

    // Accounting invoice — same shared pieces as the manual "Renew &
    // Invoice Now" and cron org paths: provider facade, invoice address,
    // per-tier nominal code, add-on extra lines, training-fund processing,
    // and dual provider id columns via buildInvoiceColumnUpdate. Failure is
    // non-fatal for the membership record but is surfaced on the workflow
    // log so admins see "record created, invoice failed".
    let invoice = null;
    let invoiceError = null;
    let providerLabel = 'Xero';
    try {
      const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('./accountingProvider.js');
      const { resolveInvoiceAddress } = await import('./invoiceAddressResolver.js');
      const { resolveMembershipNominalCode } = await import('./membershipNominalCode.js');
      const { buildExtraLineItems, processTrainingFundAddons } = await import('./membershipAddons.js');
      const provider = await getAccountingProvider(tenantId);
      providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
      const invoiceReference = poNumber
        ? `Membership ${targetYearLabel} - PO: ${poNumber}`
        : `Membership ${targetYearLabel}`;
      invoice = await provider.createMembershipInvoice({
        appTenantId: tenantId,
        organizationName: simResult.org.name,
        invoicingEmail: simResult.org.invoicing_email || null,
        invoicingAddress: await resolveInvoiceAddress(supabase, simResult.config, organizationId, 'organization'),
        membershipYear: targetYearLabel,
        tierLabel: simResult.tierLabel,
        finalCost: simResult.finalCost,
        currency: simResult.currency,
        reference: invoiceReference,
        vatRate: simResult.taxType || simResult.matchedBand?.vat_rate || null,
        nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
        invoiceDescription: simResult.config?.invoice_description || null,
        extraLineItems: buildExtraLineItems(addonLines),
      });

      if (invoice) {
        const { error: linkError } = await supabase
          .from('organisation_membership_history')
          .update(buildInvoiceColumnUpdate(invoice))
          .eq('id', inserted.id);
        if (linkError) {
          console.error(`[Workflows] Failed to link ${providerLabel} invoice for org ${organizationId}:`, linkError.message);
        }

        try {
          await processTrainingFundAddons({
            tenantId,
            organizationId,
            invoice,
            addonLines,
          });
        } catch (tfErr) {
          console.error(`[Workflows] Training fund add-on processing failed for org ${organizationId} (non-fatal):`, tfErr.message);
        }
      }
    } catch (invErr) {
      console.error(`[Workflows] ${providerLabel} invoice failed for org ${organizationId} (record kept, non-fatal):`, invErr.message);
      invoiceError = invErr.message;
    }

    if (!invoice) {
      // Flag the row for the admin "Retry" affordance (Task #1112): the
      // OrgMembershipTab invoice column shows a Retry button only for rows
      // with accounting_sync_status='failed', which re-mints via
      // /api/admin/membership-invoice-retry. Without this the record would
      // sit permanently invoice-less (the duplicate-year guard blocks a
      // workflow re-run).
      const { error: flagError } = await supabase
        .from('organisation_membership_history')
        .update({
          accounting_sync_status: 'failed',
          accounting_sync_error: String(invoiceError || `${providerLabel} invoice was not created`).slice(0, 500),
        })
        .eq('id', inserted.id);
      if (flagError) {
        console.error(`[Workflows] Failed to flag invoice failure for retry on record ${inserted.id}:`, flagError.message);
      }
    }

    if (invoice) {
      try {
        const { sendMembershipInvoiceEmail } = await import('./membershipInvoiceEmail.js');
        await sendMembershipInvoiceEmail({
          tenantId,
          organizationId,
          organizationName: simResult.org.name,
          membershipYear: targetYearLabel,
          finalCost: simResult.finalCost,
          currency: simResult.currency,
          tierLabel: simResult.tierLabel,
          xeroInvoiceNumber: invoice.invoice_number,
          xeroInvoiceId: invoice.invoice_id,
          historyRecordId: inserted.id,
          vatAmount: simResult.vatAmount || 0,
          totalWithVat: simResult.totalWithVat || simResult.finalCost,
          onlineInvoiceUrl: invoice.online_invoice_url || null,
          tierConfig: simResult.config,
        });
      } catch (emailErr) {
        console.error(`[Workflows] Membership invoice email failed for org ${organizationId} (non-fatal):`, emailErr.message);
      }
    }

    return {
      action_type: 'create_membership',
      // A membership record without its invoice is incomplete — surface it
      // as partial so the workflow log doesn't read as a clean success.
      status: invoice ? 'success' : 'partial',
      ...(invoice
        ? { invoice_number: invoice.invoice_number || null, invoice_provider: providerLabel }
        : { invoice_error: invoiceError || `${providerLabel} invoice was not created - check the ${providerLabel} connection`, message: 'Membership record created but the invoice could not be created' }),
      membership_id: inserted.id,
      organization_id: organizationId,
      organization_name: simResult.org.name,
      tier_label: simResult.tierLabel,
      annual_cost: simResult.annualCost,
      final_cost: simResult.finalCost,
      membership_year: simResult.membershipYear.label,
      year_number: simResult.yearNumber,
      free_period_discount: simResult.freeDiscount,
      rollover_discount: simResult.rolloverDiscount,
      custom_discount_total: simResult.customDiscountTotal,
      prorata_cost: simResult.prorataCost,
    };
  } catch (error) {
    console.error('[Workflows] create_membership action error:', error);
    return { action_type: 'create_membership', status: 'failed', error: error.message };
  }
}

// Task #3211 — member-driven Create Membership: record the member's
// membership, raise the accounting invoice (renewal-cron member pattern),
// and email the member a payment-link (fee token) so they can pay by card,
// set up Direct Debit, or submit a PO on the public fee page.
async function executeCreateMemberMembership(action, workflow, memberId) {
  const tenantId = workflow.tenant_id;
  console.log(`[Workflows] create_membership routed to MEMBER path for member ${memberId}`);

  try {
    const isDryRun = !!action.config?.dry_run;

    const simResult = await simulateMembershipForMember(tenantId, memberId, {
      source: 'workflow',
      workflowName: workflow.name,
      mode: 'manual',
    });

    if (!simResult.success) {
      return {
        action_type: 'create_membership',
        status: 'failed',
        target: 'member',
        error: simResult.error,
        simulation_steps: simResult.steps,
      };
    }

    const memberName = simResult.member?.name || 'Member';
    const targetYearLabel = simResult.membershipYear.label;

    if (isDryRun) {
      return {
        action_type: 'create_membership',
        status: 'dry_run',
        target: 'member',
        member_id: memberId,
        member_name: memberName,
        tier_label: simResult.tierLabel,
        annual_cost: simResult.annualCost,
        final_cost: simResult.finalCost,
        membership_year: targetYearLabel,
        year_number: simResult.yearNumber,
        free_period_discount: simResult.freeDiscount,
        rollover_discount: simResult.rolloverDiscount,
        custom_discount_total: simResult.customDiscountTotal,
        prorata_cost: simResult.prorataCost,
        currency: simResult.currency,
        overrideApplied: simResult.overrideApplied,
        simulation_steps: simResult.steps,
      };
    }

    // Invoicing-mode guard — mirrors the org path: an explicit manual /
    // scheduled setting for this member defers to the admin UI / renewal
    // cron; anything else (including no setting) proceeds.
    const { data: yearSetting } = await supabase
      .from('member_membership_invoicing')
      .select('invoicing_mode, invoice_date')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('membership_year', targetYearLabel)
      .maybeSingle();
    let fallbackSetting = null;
    if (!yearSetting) {
      const { data: legacySetting } = await supabase
        .from('member_membership_invoicing')
        .select('invoicing_mode, invoice_date')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .is('membership_year', null)
        .maybeSingle();
      fallbackSetting = legacySetting;
    }
    const effectiveInvoicingMode = yearSetting?.invoicing_mode || fallbackSetting?.invoicing_mode || 'automatic';

    if (effectiveInvoicingMode === 'manual') {
      return {
        action_type: 'create_membership',
        status: 'skipped',
        target: 'member',
        message: `Invoicing is set to manual for ${memberName} (${targetYearLabel}). Use the admin UI to record the membership.`,
      };
    }
    if (effectiveInvoicingMode === 'scheduled') {
      const invoiceDate = yearSetting?.invoice_date || fallbackSetting?.invoice_date || null;
      return {
        action_type: 'create_membership',
        status: 'skipped',
        target: 'member',
        message: `Invoicing is set to scheduled for ${memberName} (${targetYearLabel})${invoiceDate ? ` (invoice date: ${invoiceDate})` : ''}. The scheduled renewal job will process this automatically.`,
      };
    }

    // Fee-approval guard.
    try {
      const { data: approvalSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'membership_require_approval')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (approvalSetting?.setting_value === 'true') {
        const { data: approvalRecord, error: approvalError } = await supabase
          .from('member_membership_invoicing')
          .select('fees_approved')
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId)
          .eq('membership_year', targetYearLabel)
          .maybeSingle();
        if (approvalError) {
          console.error(`[Workflows] Error checking fee approval for member ${memberId}:`, approvalError.message);
        }
        if (!approvalRecord?.fees_approved) {
          // Task #3241 — honour the config's "Auto-approve fees" setting.
          const autoResult = await autoApproveMemberFees(tenantId, memberId, {
            config: simResult.config,
            yearLabel: targetYearLabel,
          });
          if (!autoResult.approved) {
            return {
              action_type: 'create_membership',
              status: 'skipped',
              target: 'member',
              message: `Fees for ${targetYearLabel} have not been approved for ${memberName}. Approve fees on the Membership tab before the workflow can create a record.`,
            };
          }
        }
      }
    } catch (approvalErr) {
      console.error(`[Workflows] Member fee approval check failed for ${memberId}:`, approvalErr.message);
    }

    const zeroDue = isZeroDueMembership(simResult);
    // Generate once and use the exact same timestamp in both the durable row
    // and paid-transition payload.
    const paidAt = zeroDue ? new Date().toISOString() : null;

    // Duplicate-year guard. A prior zero-due insert may be retrying only its
    // deterministic paid-workflow delivery.
    if (simResult.existingRecord) {
      const { data: existingRow, error: existingRowError } = await supabase
        .from('member_membership_history')
        .select('*')
        .eq('id', simResult.existingRecord.id)
        .maybeSingle();
      if (existingRowError) throw existingRowError;
      if (existingRow?.payment_status === 'paid' && isZeroDueExistingMembership(existingRow)) {
        const paidWorkflow = await fireNewZeroDueMembershipPaidWorkflow({
          table: 'member_membership_history',
          row: existingRow,
          paidAt: existingRow.paid_at,
          source: 'workflow_member_membership_zero_due',
        });
        return {
          action_type: 'create_membership',
          status: 'success',
          settled: true,
          already_processed: true,
          paid_workflow_fired: paidWorkflow?.fired === true,
          target: 'member',
          membership_id: existingRow.id,
        };
      }
      return {
        action_type: 'create_membership',
        status: 'skipped',
        target: 'member',
        message: `Membership record for ${targetYearLabel} already exists for ${memberName}`,
      };
    }

    // Record the membership (mirrors the renewal cron's member insert).
    const { data: record, error: insertError } = await supabase
      .from('member_membership_history')
      .insert({
        tenant_id: tenantId,
        member_id: memberId,
        membership_year: targetYearLabel,
        config_id: simResult.config.id,
        band_id: simResult.matchedBand?.id || null,
        tier_label: simResult.tierLabel,
        field_value: simResult.fieldValue,
        annual_cost: simResult.annualCost,
        prorata_cost: simResult.prorataCost,
        free_period_discount: simResult.freeDiscount || 0,
        rollover_discount: simResult.rolloverDiscount || 0,
        custom_discount_total: simResult.customDiscountTotal || 0,
        custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
        final_cost: simResult.finalCost,
        currency: simResult.currency,
        billing_period: simResult.billingPeriod || 'annual',
        vat_rate_percent: simResult.vatRatePercent || null,
        vat_amount: simResult.vatAmount || 0,
        total_with_vat: simResult.totalWithVat || simResult.finalCost,
        year_number: simResult.yearNumber || null,
        prorata_days: simResult.prorataDays || null,
        free_period_days_applied: simResult.freePeriodDaysApplied || 0,
        override_applied: simResult.overrideApplied || false,
        override_type: simResult.overrideType || null,
        status: 'active',
        notes: `Created by workflow "${workflow.name}" (year ${simResult.yearNumber})`,
        ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return {
          action_type: 'create_membership',
          status: 'skipped',
          target: 'member',
          message: `Membership record for ${targetYearLabel} already exists for ${memberName} (database constraint)`,
        };
      }
      console.error('[Workflows] Error creating member membership record:', insertError);
      return { action_type: 'create_membership', status: 'failed', target: 'member', error: insertError.message };
    }

    if (zeroDue) {
      // Zero rows need no accounting invoice, fee token/email, retry flag, or
      // provider metadata. Fire the paid workflow only for this successful new
      // durable insert.
      const paidWorkflow = await fireNewZeroDueMembershipPaidWorkflow({
        table: 'member_membership_history',
        row: record,
        paidAt,
        source: 'workflow_member_membership_zero_due',
      });
      return {
        action_type: 'create_membership',
        status: 'success',
        settled: true,
        payment_status: 'paid',
        paid_at: paidAt,
        paid_workflow_fired: paidWorkflow?.fired === true,
        target: 'member',
        membership_id: record.id,
        member_id: memberId,
        member_name: memberName,
        tier_label: simResult.tierLabel,
        annual_cost: simResult.annualCost,
        final_cost: simResult.finalCost,
        membership_year: targetYearLabel,
        year_number: simResult.yearNumber,
        invoice_number: null,
        invoice_error: null,
        payment_link_sent_to: null,
        payment_link_error: null,
      };
    }

    // Accounting invoice — shared provider facade, renewal-cron member
    // pattern (dual provider id columns via buildInvoiceColumnUpdate).
    let invoice = null;
    let invoiceError = null;
    let providerLabel = 'Xero';
    try {
      const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('./accountingProvider.js');
      const { resolveInvoiceAddress } = await import('./invoiceAddressResolver.js');
      const { resolveMembershipNominalCode } = await import('./membershipNominalCode.js');
      const provider = await getAccountingProvider(tenantId);
      providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
      const invoicingAddress = await resolveInvoiceAddress(supabase, simResult.config, memberId, 'member');
      invoice = await provider.createMembershipInvoice({
        appTenantId: tenantId,
        organizationName: memberName,
        invoicingEmail: simResult.member?.email || null,
        invoicingAddress,
        membershipYear: targetYearLabel,
        tierLabel: simResult.tierLabel,
        finalCost: simResult.finalCost,
        currency: simResult.currency,
        reference: `Membership ${targetYearLabel}`,
        vatRate: simResult.taxType || simResult.matchedBand?.vat_rate || null,
        nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
        invoiceDescription: simResult.config?.invoice_description || null,
      });
      if (invoice) {
        const { error: linkError } = await supabase
          .from('member_membership_history')
          .update(buildInvoiceColumnUpdate(invoice))
          .eq('id', record.id);
        if (linkError) {
          console.error(`[Workflows] Failed to link ${providerLabel} invoice for member ${memberId}:`, linkError.message);
        }
      }
    } catch (invErr) {
      console.error(`[Workflows] ${providerLabel} invoice failed for member ${memberId} (non-fatal):`, invErr.message);
      invoiceError = invErr.message;
    }

    // Payment-link email (fee token). Idempotent: the duplicate-year guard
    // means this only runs on the execution that created the record, and the
    // helper itself reuses any pending token for (tenant, member, year).
    let emailResult = null;
    try {
      const { sendMembershipFeeTokenEmail } = await import('./membershipFeeTokenEmail.js');
      let stripeEnabled = false;
      if (simResult.config?.online_card_payment) {
        try {
          const { getStripeCredentials } = await import('./stripeCredentials.js');
          const creds = await getStripeCredentials(tenantId, 'membership');
          stripeEnabled = !!(creds?.is_enabled && creds?.publishable_key);
        } catch {}
      }
      const costBreakdown = {
        annualCost: simResult.annualCost,
        annualCostBeforeDiscounts: simResult.annualCostBeforeDiscounts,
        customDiscountTotal: simResult.customDiscountTotal || 0,
        customDiscountDetails: simResult.customDiscountDetails || [],
        prorataCost: simResult.prorataCost,
        prorataDays: simResult.prorataDays,
        dailyCost: simResult.dailyCost,
        freeDiscount: simResult.freeDiscount || 0,
        freePeriodDaysApplied: simResult.freePeriodDaysApplied || 0,
        freePeriodAmount: simResult.freePeriodAmount,
        freePeriodUnit: simResult.freePeriodUnit,
        yearNumber: simResult.yearNumber,
        rolloverDiscount: simResult.rolloverDiscount || 0,
        proRataEnabled: simResult.proRataEnabled,
        overrideType: simResult.overrideType || null,
        vatRatePercent: simResult.vatRatePercent || null,
        vatAmount: simResult.vatAmount || 0,
        totalWithVat: simResult.totalWithVat || simResult.finalCost,
        taxLabel: simResult.taxLabel || null,
      };
      emailResult = await sendMembershipFeeTokenEmail({
        client: supabase,
        tenantId,
        memberId,
        organizationName: memberName,
        membershipYear: targetYearLabel,
        finalCost: simResult.finalCost,
        currency: simResult.currency,
        tierLabel: simResult.tierLabel,
        costBreakdown,
        poNumber: null,
        tierConfig: simResult.config,
        stripeEnabled,
        xeroInvoiceId: invoice?.invoice_id || null,
        xeroInvoiceNumber: invoice?.invoice_number || null,
        xeroOnlineInvoiceUrl: invoice?.online_invoice_url || null,
        historyRecordId: record.id,
      });
      if (!emailResult?.success) {
        console.error(`[Workflows] Fee-link email failed for member ${memberId}:`, emailResult?.error);
      }
    } catch (emailErr) {
      console.error(`[Workflows] Fee-link email error for member ${memberId} (non-fatal):`, emailErr.message);
      emailResult = { success: false, error: emailErr.message };
    }

    // Member note for the admin timeline (best-effort).
    try {
      const invoiceNote = invoice
        ? ` ${providerLabel} invoice ${invoice.invoice_number || '(no invoice number)'} created.`
        : ` ${providerLabel} invoice could not be created${invoiceError ? ` (${invoiceError})` : ''}.`;
      const emailNote = emailResult?.success
        ? ` Payment link emailed to ${emailResult.sentTo?.join(', ')}.`
        : ' Payment link email could not be sent.';
      await supabase.from('member_note').insert({
        member_id: memberId,
        created_by: null,
        content: `[Membership - Workflow "${workflow.name}"] Membership recorded for ${targetYearLabel}. Fee: ${simResult.currency} ${Number(simResult.finalCost).toFixed(2)}.${invoiceNote}${emailNote}`,
      });
    } catch (noteErr) {
      console.error(`[Workflows] Failed to create member note for ${memberId} (non-fatal):`, noteErr.message);
    }

    console.log(`[Workflows] Created member membership record ${record.id} for ${memberName} - tier: ${simResult.tierLabel}, final cost: ${simResult.finalCost}, year: ${targetYearLabel}`);

    return {
      action_type: 'create_membership',
      status: 'success',
      target: 'member',
      membership_id: record.id,
      member_id: memberId,
      member_name: memberName,
      tier_label: simResult.tierLabel,
      annual_cost: simResult.annualCost,
      final_cost: simResult.finalCost,
      membership_year: targetYearLabel,
      year_number: simResult.yearNumber,
      invoice_number: invoice?.invoice_number || null,
      invoice_error: invoiceError,
      payment_link_sent_to: emailResult?.success ? emailResult.sentTo : null,
      payment_link_error: emailResult?.success ? null : (emailResult?.error || null),
    };
  } catch (error) {
    console.error('[Workflows] create_membership (member) action error:', error);
    return { action_type: 'create_membership', status: 'failed', target: 'member', error: error.message };
  }
}


// Execute role-based email: sends individual emails to all members with the specified role(s) in the organization
// roleIds parameter is an array of role IDs to send to
async function executeRoleBasedEmail(action, workflow, entityType, entityId, entityData, baseUrl, roleIds, context = {}) {
  const results = [];
  const tenantId = workflow.tenant_id;
  const formSubmissionId = context?.formSubmissionId || null;
  
  console.log(`[Workflows] Role-based email: sending to all members with roles: ${roleIds.join(', ')}`);
  
  // Get organization context - CRITICAL for multi-tenant security
  const organizationId = await getOrganizationIdFromEntity(entityType, entityId, entityData);
  
  if (!organizationId) {
    console.error(`[Workflows] Role-based email failed: could not determine organization_id`);
    results.push({
      action_type: 'send_email_role',
      status: 'failed',
      error: 'Could not determine organization context for role-based email',
      role_ids: roleIds
    });
    return results;
  }
  
  // Fetch members from all roles and deduplicate by member ID
  const membersByRole = await Promise.all(
    roleIds.map(roleId => getMembersByRoleInOrganization(roleId, organizationId))
  );
  
  // Flatten and deduplicate by member ID
  const seenIds = new Set();
  const members = [];
  for (const roleMembers of membersByRole) {
    for (const member of roleMembers) {
      if (!seenIds.has(member.id)) {
        seenIds.add(member.id);
        members.push(member);
      }
    }
  }
  
  if (members.length === 0) {
    console.log(`[Workflows] Role-based email: no members found with roles ${roleIds.join(', ')} in org ${organizationId}`);
    results.push({
      action_type: 'send_email_role',
      status: 'success',
      role_ids: roleIds,
      recipients_count: 0,
      message: 'No members found with specified roles'
    });
    return results;
  }
  
  console.log(`[Workflows] Role-based email: sending to ${members.length} unique members from ${roleIds.length} role(s)`);
  
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
        role_ids: roleIds
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
  
  // Get CC - can be manual, field-based, or role-based
  let ccEmails = [];
  
  if (action.config?.cc_mode === 'role' && action.config?.cc_role_ids?.length > 0) {
    // Role-based CC: fetch all members with the selected roles and use their emails
    console.log(`[Workflows] Role-based CC: fetching members from roles: ${action.config.cc_role_ids.join(', ')}`);
    const ccMembersByRole = await Promise.all(
      action.config.cc_role_ids.map(roleId => getMembersByRoleInOrganization(roleId, organizationId))
    );
    
    // Flatten, deduplicate, and extract emails
    const ccSeenIds = new Set();
    for (const roleMembers of ccMembersByRole) {
      for (const member of roleMembers) {
        if (!ccSeenIds.has(member.id) && member.email) {
          ccSeenIds.add(member.id);
          ccEmails.push(member.email);
        }
      }
    }
    console.log(`[Workflows] Role-based CC: ${ccEmails.length} unique CC recipients`);
  } else {
    // Manual or field-based CC
    let ccResolved = action.config?.cc || '';
    ccResolved = await resolveFieldIdPlaceholder(ccResolved, entityType, entityId);
    const ccValue = ccResolved ? replacePlaceholders(ccResolved, entityType, entityData) : '';
    if (ccValue) {
      ccEmails = ccValue.split(',').map(e => e.trim()).filter(e => e);
    }
  }
  
  const cc = ccEmails.length > 0 ? ccEmails.join(', ') : undefined;
  
  // BCC stays manual/field-based only
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
  
  // Resolve dd_owner once for this workflow run (same for every recipient).
  // Falls back to empty when no submission context is available.
  const ddOwnerVals = await resolveDdOwnerForSubmission({ tenantId, formSubmissionId });

  // Pre-fetch org data once for member-triggered workflows (avoid per-member DB calls)
  let triggerMemberOrgData = null;
  if (entityType === 'member' && entityData?.organization_id) {
    const { data: orgData } = await supabase
      .from('organization')
      .select('*')
      .eq('id', entityData.organization_id)
      .single();
    triggerMemberOrgData = orgData;
    console.log(`[Workflows] Role-based email: pre-fetched org data for member-triggered workflow (org=${entityData.organization_id}, name="${orgData?.name}")`);
  }
  
  for (const member of members) {
    try {
      // Start with fresh template for each member
      let memberSubject = baseSubject;
      let memberBody = baseBody;
      
      // Debug: Log member data and entity data for first member to trace placeholder issues
      if (members.indexOf(member) === 0) {
        console.log(`[Workflows] Role-based email DEBUG - entityType: "${entityType}", entityId: "${entityId}"`);
        console.log(`[Workflows] Role-based email DEBUG - entityData keys: ${entityData ? Object.keys(entityData).join(', ') : 'null'}`);
        console.log(`[Workflows] Role-based email DEBUG - entityData.name: "${entityData?.name}", entityData.id: "${entityData?.id}"`);
        console.log(`[Workflows] Role-based email DEBUG - field_mappings: ${JSON.stringify(action.config?.field_mappings)}`);
        console.log(`[Workflows] Role-based email DEBUG - member keys: ${Object.keys(member).join(', ')}`);
        console.log(`[Workflows] Role-based email DEBUG - member.first_name: "${member.first_name}", member.id: "${member.id}", member.email: "${member.email}"`);
        console.log(`[Workflows] Role-based email DEBUG - baseUrl: "${baseUrl}"`);
        // Log a snippet of the template to see if placeholders are present
        const bodySnippet = memberBody?.substring(0, 300) || '(empty)';
        console.log(`[Workflows] Role-based email DEBUG - template body snippet (first 300 chars): ${bodySnippet}`);
      }
      
      // Step 1: Apply field mappings for BOTH contexts (trigger entity + member)
      // Use preserveEmpty=true for trigger context so member placeholders survive
      if (action.config?.field_mappings && Object.keys(action.config.field_mappings).length > 0) {
        // Apply trigger entity field mappings first (with preserveEmpty=true)
        // IMPORTANT: When trigger entity is 'member', skip this pass entirely to prevent
        // the trigger member's data from overwriting placeholders meant for role members
        if (entityType !== 'member') {
          console.log(`[Workflows] Role-based email: applying trigger entity field mappings for ${entityType}:${entityId} (preserveEmpty=true)`);
          memberSubject = await applyFieldMappings(memberSubject, action.config.field_mappings, entityType, entityId, entityData, true);
          memberBody = await applyFieldMappings(memberBody, action.config.field_mappings, entityType, entityId, entityData, true);
        } else {
          console.log(`[Workflows] Role-based email: SKIPPING trigger entity pass (entityType is 'member' - would overwrite role member placeholders)`);
          // For member-triggered workflows, we need to resolve org fields separately
          // Use pre-fetched org data to avoid per-member DB calls
          if (triggerMemberOrgData) {
            console.log(`[Workflows] Role-based email: applying org field mappings from member's org ${entityData.organization_id}`);
            memberSubject = await applyFieldMappings(memberSubject, action.config.field_mappings, 'organization', entityData.organization_id, triggerMemberOrgData, true);
            memberBody = await applyFieldMappings(memberBody, action.config.field_mappings, 'organization', entityData.organization_id, triggerMemberOrgData, true);
          }
        }
        
        // Then apply member-specific field mappings using each ROLE MEMBER's data (not trigger member)
        console.log(`[Workflows] Role-based email: applying member field mappings for member ${member.id} (first_name="${member.first_name}")`);
        memberSubject = await applyFieldMappings(memberSubject, action.config.field_mappings, 'member', member.id, member, false);
        memberBody = await applyFieldMappings(memberBody, action.config.field_mappings, 'member', member.id, member, false);
        
        // Debug: Log after field mappings for first member
        if (members.indexOf(member) === 0) {
          const afterMappingsSnippet = memberBody?.substring(0, 300) || '(empty)';
          console.log(`[Workflows] Role-based email DEBUG - body after field mappings (first 300 chars): ${afterMappingsSnippet}`);
        }
      }
      
      // Step 2: Resolve UUID-style field ID placeholders for member's custom fields
      memberSubject = await resolveFieldIdPlaceholder(memberSubject, 'member', member.id);
      memberBody = await resolveFieldIdPlaceholder(memberBody, 'member', member.id);
      
      // Step 3: Replace standard placeholders - member first, then trigger entity
      // Member placeholders: {{member.first_name}}, {{first_name}}, etc.
      const memberPrefContext = member.id ? { tenantBaseUrl: baseUrl, tenantId, memberId: member.id } : null;
      memberSubject = replacePlaceholders(memberSubject, 'member', member, memberPrefContext);
      memberBody = replacePlaceholders(memberBody, 'member', member, memberPrefContext);
      
      // Trigger entity placeholders: {{organization.name}}, {{name}}, etc.
      memberSubject = replacePlaceholders(memberSubject, entityType, entityData, null);
      memberBody = replacePlaceholders(memberBody, entityType, entityData, null);
      
      // For member-triggered workflows, also resolve org placeholders via replacePlaceholders
      if (entityType === 'member' && triggerMemberOrgData) {
        memberSubject = replacePlaceholders(memberSubject, 'organization', triggerMemberOrgData, null);
        memberBody = replacePlaceholders(memberBody, 'organization', triggerMemberOrgData, null);
      }
      
      // Step 4: Process special placeholders like {{set_password_url}} for THIS member
      // Task #3253 — derive a tenant base URL from the tenant slug when the
      // caller provided none (background/webhook paths).
      let roleEffectiveBaseUrl = baseUrl;
      if (!roleEffectiveBaseUrl && hasSetPasswordToken(memberSubject, memberBody)) {
        roleEffectiveBaseUrl = await resolveWorkflowBaseUrl(baseUrl, tenantId);
      }
      if (roleEffectiveBaseUrl) {
        memberSubject = await processSpecialPlaceholders(memberSubject, 'member', member.id, roleEffectiveBaseUrl);
        memberBody = await processSpecialPlaceholders(memberBody, 'member', member.id, roleEffectiveBaseUrl);
      } else {
        console.warn(`[Workflows] Role-based email: baseUrl is empty/missing - cannot process {{set_password_url}} placeholder`);
      }

      // Task #3253 — never let a raw set_password_url token reach a recipient.
      memberSubject = stripUnresolvedSetPasswordToken(memberSubject, 'role-email subject');
      memberBody = stripUnresolvedSetPasswordToken(memberBody, 'role-email body');
      
      // Debug: Log final body for first member to verify all placeholders resolved
      if (members.indexOf(member) === 0) {
        const finalSnippet = memberBody?.substring(0, 300) || '(empty)';
        console.log(`[Workflows] Role-based email DEBUG - FINAL body (first 300 chars): ${finalSnippet}`);
        // Check for any remaining unresolved placeholders
        const remainingCurly = memberBody?.match(/\{\{[^}]+\}\}/g) || [];
        const remainingBracket = memberBody?.match(/\[\[[^\]]+\]\]/g) || [];
        if (remainingCurly.length > 0 || remainingBracket.length > 0) {
          console.warn(`[Workflows] Role-based email DEBUG - UNRESOLVED placeholders remaining: {{}} = [${remainingCurly.join(', ')}], [[]] = [${remainingBracket.join(', ')}]`);
        }
      }
      
      // Apply pre-resolved dd_owner values (resolved once before the loop).
      memberSubject = applyDdOwnerPlaceholders(memberSubject, ddOwnerVals);
      memberBody = applyDdOwnerPlaceholders(memberBody, ddOwnerVals);

      console.log(`[Workflows] Role-based email: sending to ${member.email}`);
      
      const inboxDelivery = await buildInboxDelivery({
        tenantId,
        memberId: member.id,
        email: member.email,
        labelKey: 'automations',
      });
      const emailResult = await sendEmail({
        to: member.email,
        subject: memberSubject,
        html: memberBody,
        from: fromEmail,
        replyTo,
        cc,
        bcc,
        tenantId,
        inboxDelivery
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
    role_id: roleIds[0], // Backward compatibility for consumers expecting single role_id
    role_ids: roleIds,
    recipients_count: members.length,
    success_count: successCount,
    fail_count: failCount,
    template_id: action.config?.template_id,
    cc_role_ids: action.config?.cc_role_ids,
    cc_count: ccEmails ? ccEmails.length : 0,
    details: emailResults
  });
  
  return results;
}

async function checkOncePerRecord(workflow, entityType, entityId) {
  if (workflow.trigger_mode !== 'once_per_record') return false;
  
  // 'skipped' rows record conditions-not-met runs where NOTHING executed —
  // they must not count as "already ran" or a once_per_record workflow whose
  // conditions were false on first trigger could never execute later.
  const { data: existingLogs } = await supabase
    .from('workflow_log')
    .select('id')
    .eq('workflow_id', workflow.id)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .neq('status', 'skipped')
    .limit(1);
  
  return existingLogs && existingLogs.length > 0;
}

async function logWorkflowExecution(workflow, entityType, entityId, triggerData, results) {
  // Task #3244 — don't log an unqualified "success" when actions were
  // skipped or failed. NOTE: status 'skipped' is reserved for
  // conditions-not-met runs (checkOncePerRecord relies on that), so runs
  // with skipped/failed actions are logged as 'partial' / 'failed'.
  const statuses = (results || []).map(r => r?.status);
  const hasFailed = statuses.includes('failed');
  const hasSkippedOrPartial = statuses.includes('skipped') || statuses.includes('partial');
  let status = 'success';
  if (hasFailed) {
    status = statuses.some(s => s === 'success' || s === 'partial' || s === 'skipped') ? 'partial' : 'failed';
  } else if (hasSkippedOrPartial) {
    status = 'partial';
  }
  const problems = (results || [])
    .filter(r => r?.status === 'skipped' || r?.status === 'failed' || r?.status === 'partial')
    .map(r => `${r.action_type || 'action'} ${r.status}${r.message ? `: ${r.message}` : r.error ? `: ${r.error}` : ''}`);
  await supabase.from('workflow_log').insert({
    tenant_id: workflow.tenant_id,
    workflow_id: workflow.id,
    entity_type: entityType,
    entity_id: entityId,
    trigger_data: triggerData,
    actions_executed: results,
    status,
    ...(problems.length > 0 ? { error_message: problems.join(' | ') } : {}),
  });
  console.log(`[Workflows] Logged execution for ${workflow.name}`);
}

async function claimWorkflowDelivery({ deliveryKey, tenantId, entityType, entityId }) {
  const ownerToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const { data: inserted, error: insertErr } = await supabase
    .from('workflow_delivery_claim')
    .insert({
      delivery_key: deliveryKey,
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      status: 'processing',
      owner_token: ownerToken,
      claimed_at: now,
      updated_at: now,
    })
    .select('*')
    .maybeSingle();
  if (!insertErr && inserted) return { owned: true, ownerToken };
  if (insertErr?.code !== '23505') {
    throw new Error(`workflow delivery claim failed: ${insertErr?.message || 'no claim row returned'}`);
  }

  const { data: existing, error: readErr } = await supabase
    .from('workflow_delivery_claim')
    .select('*')
    .eq('delivery_key', deliveryKey)
    .maybeSingle();
  if (readErr || !existing) {
    throw new Error(`workflow delivery claim reload failed: ${readErr?.message || 'row missing'}`);
  }
  if (existing.status === 'completed') return { owned: false, completed: true };
  // Never auto-reclaim an ambiguous action batch. A worker may have sent an
  // email or performed another external action before crashing, and those
  // sinks do not all accept idempotency keys. Replaying would risk duplicate
  // side effects. Keep the durable failed/processing claim for explicit
  // operator review instead.
  return { owned: false, inProgress: true, needsAttention: true };
}

async function finishWorkflowDelivery(deliveryKey, ownerToken) {
  const { data, error } = await supabase
    .from('workflow_delivery_claim')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('delivery_key', deliveryKey)
    .eq('owner_token', ownerToken)
    .select('delivery_key')
    .maybeSingle();
  if (error) throw new Error(`workflow delivery completion failed: ${error.message}`);
  if (!data) throw new Error('workflow delivery completion failed: ownership lost');
}

async function failWorkflowDelivery(deliveryKey, ownerToken, error) {
  await supabase
    .from('workflow_delivery_claim')
    .update({
      status: 'failed',
      last_error: String(error?.message || error || 'workflow dispatch failed').slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq('delivery_key', deliveryKey)
    .eq('owner_token', ownerToken);
}

export async function triggerWorkflows(entityType, entityId, beforeData, afterData, triggerType, baseUrl, context = {}) {
  console.log(`[Workflows] triggerWorkflows called: entityType=${entityType}, entityId=${entityId}, triggerType=${triggerType}`);
  console.log(`[Workflows] afterData.tenant_id=${afterData?.tenant_id}, beforeData.tenant_id=${beforeData?.tenant_id}`);
  
  const pendingConfirmations = [];
  const reverts = [];
  const blockedDeliveries = [];
  
  if (!supabase) {
    console.log(`[Workflows] No supabase client available, skipping`);
    return { pendingConfirmations, reverts };
  }
  
  let deliveryClaim = null;
  const usesPerWorkflowDelivery = Boolean(context.attendance && context.deliveryKey);
  try {
    // Get tenant_id from entity data (afterData or beforeData)
    let tenantId = afterData?.tenant_id || beforeData?.tenant_id;
    console.log(`[Workflows] Initial tenantId from data: ${tenantId}`);
    
    // If tenant_id not in payload, resolve from entity (for member entities that may have org_id)
    if (!tenantId && entityId) {
      console.log(`[Workflows] Resolving tenant_id from ${entityType} table for id ${entityId}`);
      const table = entityType === 'job_posting' ? 'job_posting' : entityType;
      const { data: entity, error: entityError } = await supabase
        .from(table)
        .select('tenant_id')
        .eq('id', entityId)
        .single();
      console.log(`[Workflows] Entity lookup result:`, entity, 'error:', entityError);
      if (entity?.tenant_id) {
        tenantId = entity.tenant_id;
      }
    }
    
    // SECURITY: Require tenant_id to prevent cross-tenant workflow execution
    if (!tenantId) {
      console.log(`[Workflows] No tenant_id available for ${entityType}:${entityId}, skipping workflow evaluation`);
      return { pendingConfirmations, reverts };
    }
    
    console.log(`[Workflows] Querying workflows: entity_type=${entityType}, tenant_id=${tenantId}, is_active=true`);
    const { data: workflows, error: workflowError } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .eq('tenant_id', tenantId)
      .eq('is_active', true);

    console.log(`[Workflows] Query result: ${workflows?.length || 0} workflows found, error:`, workflowError);
    if (workflowError && context.deliveryKey) {
      throw new Error(`load workflows for durable delivery failed: ${workflowError.message}`);
    }
    
    if (!workflows || workflows.length === 0) {
      console.log(`[Workflows] No matching workflows found for ${entityType} in tenant ${tenantId}`);
      return {
        pendingConfirmations,
        reverts,
        ...(context.deliveryKey ? { delivery: { status: 'completed', noop: true } } : {}),
      };
    }
    if (context.deliveryKey && !usesPerWorkflowDelivery) {
      deliveryClaim = await claimWorkflowDelivery({
        deliveryKey: context.deliveryKey,
        tenantId,
        entityType,
        entityId,
      });
      if (deliveryClaim.completed) {
        return { pendingConfirmations, reverts, delivery: { status: 'completed', duplicate: true } };
      }
      if (!deliveryClaim.owned) {
        return { pendingConfirmations, reverts, delivery: { status: 'in_progress' } };
      }
    }
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType}:${entityId} (tenant: ${tenantId})`);

    // Task 3197: re-check path restricts evaluation to an explicit workflow
    // id set (workflows whose record_create run was skipped on conditions).
    const onlyWorkflowIds = Array.isArray(context.onlyWorkflowIds) && context.onlyWorkflowIds.length > 0
      ? new Set(context.onlyWorkflowIds)
      : null;

    for (const workflow of workflows) {
      if (onlyWorkflowIds && !onlyWorkflowIds.has(workflow.id)) continue;
      console.log(`[Workflows] Checking workflow "${workflow.name}": trigger_type="${workflow.trigger_type}", incoming triggerType="${triggerType}"`);
      let triggerMatches = false;
      
      if (workflow.trigger_type === 'record_update' && triggerType === 'field_change') {
        triggerMatches = true;
        console.log(`[Workflows] "${workflow.name}" matched: record_update triggered by field_change`);
      } else if (workflow.trigger_type === 'record_create' && triggerType === 'record_create') {
        triggerMatches = true;
        console.log(`[Workflows] "${workflow.name}" matched: record_create`);
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
      } else if (
        (workflow.trigger_type === 'attendance_result' || workflow.trigger_type === 'event_attendance_result')
        && (triggerType === 'attendance_result' || triggerType === 'attendance_transition')
      ) {
        triggerMatches = attendanceTriggerMatches(workflow.trigger_config || {}, context.attendance || {});
        console.log(`[Workflows] "${workflow.name}" attendance result match: ${triggerMatches}`);
      }

      if (!triggerMatches) {
        console.log(`[Workflows] Skipping "${workflow.name}" - trigger type mismatch (workflow: ${workflow.trigger_type}, event: ${triggerType})`);
        continue;
      }

      // Task #3232: loop guard for workflow-initiated chains — a workflow
      // already in this chain must not run again (A -> B -> A / self-trigger).
      if (Array.isArray(context.chain?.visited) && context.chain.visited.includes(workflow.id)) {
        console.log(`[Workflows] Chain loop guard: "${workflow.name}" already ran in this chain - skipping`);
        await logChainGuardSkip(workflow, entityType, entityId, 'chain_loop_guard', context.chain);
        continue;
      }

      let allConditionsMet = true;
      const conditionResults = [];
      console.log(`[Workflows] ${workflow.name} - conditions array:`, JSON.stringify(workflow.conditions));
      console.log(`[Workflows] ${workflow.name} - afterData keys:`, afterData ? Object.keys(afterData) : 'null');
      console.log(`[Workflows] ${workflow.name} - afterData.login_enabled:`, afterData?.login_enabled, 'type:', typeof afterData?.login_enabled);
      
      if (workflow.conditions && workflow.conditions.length > 0) {
        console.log(`[Workflows] Evaluating ${workflow.conditions.length} conditions for ${workflow.name}`);
        
        for (let i = 0; i < workflow.conditions.length; i++) {
          const condition = workflow.conditions[i];
          let beforeValue, afterValue;
          
          // Normalize field_type: handle prefixed types like member_core, org_core, member_custom, org_custom, job_posting_core
          const fieldType = condition.field_type || 'core';
          const isMemberField = fieldType === 'core' || fieldType === 'member_core';
          const isOrgField = fieldType === 'org_core';
          const isMemberCustom = fieldType === 'custom' || fieldType === 'member_custom';
          const isOrgCustom = fieldType === 'org_custom';
          const isJobPostingField = fieldType === 'job_posting_core';
          const isAttendanceField = isAttendanceConditionField(fieldType, condition.field_id);
          
          console.log(`[Workflows] Condition ${i} field_type="${fieldType}", isMemberField=${isMemberField}, isOrgField=${isOrgField}, isMemberCustom=${isMemberCustom}, isOrgCustom=${isOrgCustom}, isJobPostingField=${isJobPostingField}`);
          
          // Attendance values may only come from the normalized server-side
          // transition context, never arbitrary provider/outbox metadata.
          if ((triggerType === 'attendance_result' || triggerType === 'attendance_transition') && isAttendanceField) {
            beforeValue = undefined;
            afterValue = ATTENDANCE_CONDITION_FIELDS.has(condition.field_id)
              ? context.attendance?.[condition.field_id]
              : undefined;
            console.log(`[Workflows] Attendance field "${condition.field_id}": afterValue="${afterValue}"`);
          // For job_posting entity type, treat 'core' as job posting core field
          } else if ((entityType === 'job_posting' && (fieldType === 'core' || isJobPostingField)) || isJobPostingField) {
            // Job posting core field - get from afterData (which is the job_posting record)
            beforeValue = beforeData?.[condition.field_id];
            afterValue = afterData?.[condition.field_id];
            console.log(`[Workflows] Job posting core field "${condition.field_id}": afterValue="${afterValue}"`);
          } else if (isMemberField) {
            // Member core field - get from afterData (which is the member record)
            beforeValue = beforeData?.[condition.field_id];
            afterValue = afterData?.[condition.field_id];
            console.log(`[Workflows] Member core field "${condition.field_id}": afterValue="${afterValue}"`);
          } else if (isOrgField) {
            // Organization core field
            // For organization entity: use afterData directly (the org itself)
            // For member entity: fetch from organization table using organization_id
            if (entityType === 'organization') {
              afterValue = afterData?.[condition.field_id];
              console.log(`[Workflows] Org core field "${condition.field_id}" (direct): afterValue="${afterValue}"`);
            } else if (afterData?.organization_id) {
              const { data: orgData } = await supabase
                .from('organization')
                .select('*')
                .eq('id', afterData.organization_id)
                .single();
              afterValue = orgData?.[condition.field_id];
              console.log(`[Workflows] Org core field "${condition.field_id}" for org ${afterData.organization_id}: afterValue="${afterValue}"`);
            }
          } else if (isMemberCustom) {
            // Member custom field - fetch from member_preference_value
            if (afterData?.id) {
              const { data: prefValue } = await supabase
                .from('member_preference_value')
                .select('value')
                .eq('member_id', afterData.id)
                .eq('field_id', condition.field_id)
                .single();
              afterValue = prefValue?.value;
              console.log(`[Workflows] Member custom field "${condition.field_id}": afterValue="${afterValue}"`);
            }
          } else if (isOrgCustom) {
            // Organization custom field - fetch from organization_preference_value
            // For organization entity: use afterData.id (the org itself)
            // For member entity: use afterData.organization_id (the member's org)
            const orgIdForCustomField = entityType === 'organization' ? afterData?.id : afterData?.organization_id;
            if (orgIdForCustomField) {
              const { data: prefValue } = await supabase
                .from('organization_preference_value')
                .select('value')
                .eq('organization_id', orgIdForCustomField)
                .eq('field_id', condition.field_id)
                .single();
              afterValue = prefValue?.value;
              console.log(`[Workflows] Org custom field "${condition.field_id}" for org ${orgIdForCustomField}: afterValue="${afterValue}"`);
            } else {
              console.log(`[Workflows] Org custom field "${condition.field_id}": no org ID available (entityType=${entityType})`);
            }
          } else {
            console.log(`[Workflows] Unknown field_type "${fieldType}" for condition "${condition.field_id}" - skipping`);
            continue;
          }
          
          const actualValue = String(afterValue ?? '');
          
          const conditionMet = evaluateConditionOperator(condition.operator, afterValue, condition.value, beforeValue);
          
          conditionResults.push({
            field_id: condition.field_id,
            operator: condition.operator,
            expected: condition.value,
            actual: actualValue,
            met: conditionMet
          });
          
          console.log(`[Workflows] Condition ${i}: field="${condition.field_id}", op="${condition.operator}", value="${condition.value}", actual="${actualValue}", met=${conditionMet}, logic=${condition.logic || 'AND'}`);
          
          if (i === 0) {
            allConditionsMet = conditionMet;
            console.log(`[Workflows] After condition ${i}: allConditionsMet=${allConditionsMet} (initial)`);
          } else {
            const prevValue = allConditionsMet;
            if (condition.logic === 'OR') {
              allConditionsMet = allConditionsMet || conditionMet;
            } else {
              allConditionsMet = allConditionsMet && conditionMet;
            }
            console.log(`[Workflows] After condition ${i}: ${prevValue} ${condition.logic || 'AND'} ${conditionMet} = ${allConditionsMet}`);
          }
        }
        
        console.log(`[Workflows] Final allConditionsMet for ${workflow.name}: ${allConditionsMet}`);
      }

      if (await checkOncePerRecord(workflow, entityType, entityId)) {
        console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
        continue;
      }

      // Task #3232: system-initiated changes (a workflow set the field) have
      // no human present to confirm — bypass the confirmation gate and run.
      if (workflow.trigger_type === 'field_change' && workflow.trigger_config?.requires_confirmation && !context.systemInitiated) {
        console.log(`[Workflows] Workflow "${workflow.name}" requires user confirmation - adding to pending list (conditions_met=${allConditionsMet})`);
        const revertFieldId = workflow.trigger_config?.field_id;
        const revertFieldType = workflow.trigger_config?.field_type || 'core';
        const conditionSummaries = await buildConditionSummaries(workflow.conditions, workflow.tenant_id, entityType);
        const confirmationData = {
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          entity_type: entityType,
          entity_id: entityId,
          actions: await Promise.all((workflow.actions || []).map(a => buildActionSummary(a, workflow.tenant_id, { entityType, entityId, entityData: afterData }))),
          conditions_met: allConditionsMet,
          condition_results: conditionResults.length > 0 ? conditionResults : undefined,
          condition_summaries: conditionSummaries.length > 0 ? conditionSummaries : undefined,
          revert_on_fail: workflow.revert_trigger_on_condition_fail || false,
          revert_field_id: revertFieldId,
          revert_field_type: revertFieldType,
          revert_previous_value: revertFieldType === 'custom' ? undefined : beforeData?.[revertFieldId]
        };
        pendingConfirmations.push(confirmationData);
        continue;
      }
      
      if (!allConditionsMet) {
        console.log(`[Workflows] Conditions not met for workflow: ${workflow.name} - SKIPPING`);

        // Task 3196: record a skipped run so admins can see WHY nothing was
        // sent (per-condition expected vs actual), instead of the skip being
        // visible only in server logs. Never let logging failures break the
        // trigger path.
        // Task 3197: the post-create re-check path suppresses these rows —
        // one skipped row from the original create is enough; re-checking on
        // every preference-value save must not spam the log.
        if (context.suppressSkipLog) {
          continue;
        }
        try {
          await supabase.from('workflow_log').insert({
            tenant_id: workflow.tenant_id,
            workflow_id: workflow.id,
            entity_type: entityType,
            entity_id: entityId,
            trigger_data: {
              trigger_type: triggerType,
              condition_results: conditionResults,
              reason: 'conditions_not_met',
              ...(context.triggerData || {}),
            },
            actions_executed: [],
            status: 'skipped',
          });
          console.log(`[Workflows] Logged skipped run for ${workflow.name} (conditions not met)`);
        } catch (skipLogErr) {
          console.error(`[Workflows] Failed to log skipped run for ${workflow.name}:`, skipLogErr);
        }
        
        if (workflow.revert_trigger_on_condition_fail && workflow.trigger_type === 'field_change' && workflow.trigger_config?.field_id) {
          const revertFieldId = workflow.trigger_config.field_id;
          const revertFieldType = workflow.trigger_config.field_type || 'core';
          
          if (revertFieldType === 'custom') {
            console.log(`[Workflows] Revert trigger not supported for custom field workflows in this path - skipping revert for "${workflow.name}"`);
          } else if (!reverts.some(r => r.field_id === revertFieldId)) {
            const previousValue = beforeData?.[revertFieldId];
            const currentValue = afterData?.[revertFieldId];
            
            console.log(`[Workflows] Revert trigger enabled for "${workflow.name}" - reverting ${entityType}.${revertFieldId} from "${currentValue}" back to "${previousValue}"`);
            
            try {
              const revertTable = entityType === 'job_posting' ? 'job_posting' : entityType;
              const { error: revertError } = await supabase
                .from(revertTable)
                .update({ [revertFieldId]: previousValue ?? null })
                .eq('id', entityId);
                
              if (revertError) {
                console.error(`[Workflows] Failed to revert ${revertFieldId}:`, revertError);
              } else {
                console.log(`[Workflows] Successfully reverted ${revertFieldId} to "${previousValue}"`);
                reverts.push({
                  workflow_name: workflow.name,
                  field_id: revertFieldId,
                  field_type: revertFieldType,
                  reverted_from: currentValue,
                  reverted_to: previousValue,
                  reason: `Conditions not met for workflow "${workflow.name}"`
                });
              }
            } catch (revertErr) {
              console.error(`[Workflows] Error reverting trigger for "${workflow.name}":`, revertErr);
            }
          } else {
            console.log(`[Workflows] Field ${revertFieldId} already reverted by another workflow - skipping for "${workflow.name}"`);
          }
        }
        
        continue;
      }

      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      const actionEntityId = context.attendance && context.actionEntityId
        ? context.actionEntityId
        : entityId;
      const workflowDeliveryKey = usesPerWorkflowDelivery
        ? attendanceWorkflowDeliveryKey({
          tenantId,
          workflowId: workflow.id,
          entityId,
          triggerMode: workflow.trigger_mode,
          transitionDeliveryKey: context.deliveryKey,
        })
        : context.deliveryKey;
      let workflowDeliveryClaim = null;
      if (usesPerWorkflowDelivery) {
        workflowDeliveryClaim = await claimWorkflowDelivery({
          deliveryKey: workflowDeliveryKey,
          tenantId,
          entityType,
          entityId,
        });
        if (workflowDeliveryClaim.completed) continue;
        if (!workflowDeliveryClaim.owned) {
          blockedDeliveries.push({
            workflow_id: workflow.id,
            workflow_name: workflow.name,
            delivery_key: workflowDeliveryKey,
            reason: 'delivery_claim_needs_attention',
          });
          await supabase.from('workflow_log').insert({
            tenant_id: workflow.tenant_id,
            workflow_id: workflow.id,
            entity_type: entityType,
            entity_id: entityId,
            trigger_data: {
              trigger_type: triggerType,
              ...(context.triggerData || {}),
              reason: 'delivery_claim_needs_attention',
            },
            actions_executed: [],
            status: 'failed',
            error_message: 'A prior attendance workflow action attempt did not complete cleanly and was not replayed.',
          });
          continue;
        }
      }
      try {
        const results = await executeWorkflowActions(
          workflow,
          entityType,
          actionEntityId,
          afterData || {},
          baseUrl,
          context,
        );
        await logWorkflowExecution(workflow, entityType, entityId, { before: beforeData, after: afterData, trigger_type: triggerType, ...(context.triggerData || {}), ...(context.systemInitiated ? { system_initiated: true, ...(context.triggeredByWorkflow ? { triggered_by_workflow: context.triggeredByWorkflow } : {}) } : {}) }, results);
        if (workflowDeliveryClaim?.owned) {
          await finishWorkflowDelivery(workflowDeliveryKey, workflowDeliveryClaim.ownerToken);
        }
      } catch (workflowError) {
        if (workflowDeliveryClaim?.owned) {
          await failWorkflowDelivery(workflowDeliveryKey, workflowDeliveryClaim.ownerToken, workflowError);
          await supabase.from('workflow_log').insert({
            tenant_id: workflow.tenant_id,
            workflow_id: workflow.id,
            entity_type: entityType,
            entity_id: entityId,
            trigger_data: {
              trigger_type: triggerType,
              ...(context.triggerData || {}),
              reason: 'workflow_execution_failed',
            },
            actions_executed: [],
            status: 'failed',
            error_message: workflowError?.message || 'Attendance workflow execution failed',
          });
          blockedDeliveries.push({
            workflow_id: workflow.id,
            workflow_name: workflow.name,
            delivery_key: workflowDeliveryKey,
            reason: 'workflow_execution_failed',
          });
          continue;
        }
        throw workflowError;
      }
    }
    
    if (deliveryClaim?.owned && !usesPerWorkflowDelivery) {
      await finishWorkflowDelivery(context.deliveryKey, deliveryClaim.ownerToken);
    }
    return {
      pendingConfirmations,
      reverts,
      ...(context.deliveryKey ? {
        delivery: blockedDeliveries.length > 0
          ? { status: 'blocked', blocked: blockedDeliveries }
          : { status: 'completed' },
      } : {}),
    };
  } catch (err) {
    console.error('[Workflows] Error:', err.message, err.stack);
    if (deliveryClaim?.owned && !usesPerWorkflowDelivery) {
      await failWorkflowDelivery(context.deliveryKey, deliveryClaim.ownerToken, err);
    }
    if (context.deliveryKey) throw err;
    return { pendingConfirmations: [], reverts: [] };
  }
}

/**
 * Dispatch one server-loaded durable attendance transition. Immediate
 * publication and outbox recovery should both call this function.
 */
export async function processAttendanceResultTransition(transition, baseUrl = '') {
  const normalized = normalizeAttendanceResultTransition(transition);
  const attendance = { ...normalized.conditionContext };
  let memberData = null;

  // Enrich from tenant-scoped database records rather than trusting denormalized
  // provider metadata. This also preserves existing member core conditions and
  // email placeholder/recipient behaviour for attendance-triggered workflows.
  const bookingTable = attendance.booking_type === 'complex_event_booking'
    ? 'complex_event_booking'
    : attendance.booking_type === 'booking' ? 'booking' : null;
  if (bookingTable) {
    const { data: booking, error } = await supabase
      .from(bookingTable)
      .select('*')
      .eq('id', normalized.bookingId)
      .eq('tenant_id', normalized.tenantId)
      .maybeSingle();
    if (error) throw new Error(`load trusted attendance booking failed: ${error.message}`);
    if (!booking) throw new Error(`trusted attendance booking ${normalized.bookingId} was not found`);
    attendance.attendee_email = booking.attendee_email || booking.email || attendance.attendee_email;
    attendance.attendee_name = booking.attendee_name
      || [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ')
      || attendance.attendee_name;
    attendance.ticket_id = booking.ticket_class_id || attendance.ticket_id;
    attendance.ticket_name = booking.ticket_class_name || attendance.ticket_name;
    attendance.ticket_type = booking.ticket_class_name || attendance.ticket_type;
    attendance.booking_reference = booking.booking_reference || attendance.booking_reference;
  }
  if (normalized.memberId) {
    const { data: member, error } = await supabase
      .from('member')
      .select('*')
      .eq('id', normalized.memberId)
      .eq('tenant_id', normalized.tenantId)
      .maybeSingle();
    if (error) throw new Error(`load trusted attendance member failed: ${error.message}`);
    memberData = member;
    attendance.attendee_email = attendance.attendee_email || member?.email;
    attendance.attendee_name = attendance.attendee_name
      || [member?.first_name, member?.last_name].filter(Boolean).join(' ');
  }
  if (attendance.event_id) {
    const eventTable = attendance.booking_type === 'complex_event_booking' ? 'complex_event' : 'event';
    const { data: event, error } = await supabase
      .from(eventTable)
      .select('title')
      .eq('id', attendance.event_id)
      .eq('tenant_id', normalized.tenantId)
      .maybeSingle();
    if (error) throw new Error(`load trusted attendance event failed: ${error.message}`);
    attendance.event_name = event?.title || attendance.event_name;
  }
  if (attendance.target_type === 'event') {
    attendance.target_name = attendance.event_name || attendance.target_name;
  } else if (attendance.target_type === 'complex_event_session') {
    const { data: session, error } = await supabase
      .from('complex_event_session')
      .select('title')
      .eq('id', attendance.target_id)
      .eq('tenant_id', normalized.tenantId)
      .maybeSingle();
    if (error) throw new Error(`load trusted attendance session failed: ${error.message}`);
    attendance.target_name = session?.title || attendance.target_name;
  } else if (attendance.target_type === 'agenda_item') {
    const { data: agenda, error } = await supabase
      .from('event_agenda_item')
      .select('description,item_type')
      .eq('id', attendance.target_id)
      .eq('tenant_id', normalized.tenantId)
      .maybeSingle();
    if (error) throw new Error(`load trusted attendance agenda item failed: ${error.message}`);
    attendance.target_name = agenda?.description || agenda?.item_type || attendance.target_name;
  }
  // Attendance workflows are authored against the member condition/action
  // surface, but their durable "record" is the booking. Using the booking id
  // for claims/logs means once-per-record is once per attendee booking (not
  // once per member across all future events). actionEntityId keeps record
  // updates pointed at the trusted member when one exists.
  const entityType = 'member';
  const entityId = normalized.bookingId;
  const entityData = {
    ...(memberData || {}),
    ...attendance,
    id: normalized.memberId || normalized.bookingId,
    tenant_id: normalized.tenantId,
    email: attendance.attendee_email,
    name: attendance.attendee_name,
  };

  return triggerWorkflows(
    String(entityType),
    String(entityId),
    null,
    entityData,
    'attendance_result',
    baseUrl,
    {
      systemInitiated: true,
      attendance,
      actionEntityId: normalized.memberId || null,
      triggerData: {
        attendance_transition_id: normalized.transitionId,
        attendance_target_id: normalized.targetId,
        booking_id: normalized.bookingId,
        outcome_revision_id: normalized.revisionId,
        outcome_revision_number: attendance.attendance_revision_number,
        outcome: normalized.outcome,
        attendance,
      },
      // Corrections have a new transition id and can run again. Replaying the
      // same transition is claimed once across immediate and recovery paths.
      deliveryKey: `attendance-result:${normalized.transitionId}`,
    },
  );
}

// Task 3197: the admin UI "add member/organization" dialog creates the record
// first, then saves each custom field with separate MemberPreferenceValue /
// OrganizationPreferenceValue POSTs. record_create workflows conditioned on a
// custom field therefore evaluated against empty values at create time and
// were logged as 'skipped'. This re-check runs when a preference value arrives
// for a *recently created* record: it re-evaluates only the record_create
// workflows that (a) reference a custom field in their conditions and (b) have
// never executed for this record (no non-skipped workflow_log row), so
// workflows that already fired at create time — including trigger_mode
// 'every_time' ones — can never run twice for the same creation.
export async function recheckRecordCreateWorkflows(entityType, entityId, baseUrl, { windowMinutes = 15 } = {}) {
  if (!supabase) return;
  if (entityType !== 'member' && entityType !== 'organization') return;
  if (!entityId) return;

  try {
    const { data: record } = await supabase
      .from(entityType)
      .select('*')
      .eq('id', entityId)
      .single();
    if (!record || !record.tenant_id) return;

    // Only re-check for records created moments ago (the "same create dialog"
    // window). Older records receiving new preference values are edits, not
    // creations, and must not re-fire record_create workflows.
    // Column drift: member rows use created_on, organization rows created_at.
    // Fail closed (no re-check) when no creation timestamp exists — only
    // legacy rows lack one, and those are edits, not fresh creations.
    const createdRaw = record.created_on || record.created_at || record.created_date;
    const createdAt = createdRaw ? new Date(createdRaw) : null;
    if (!createdAt || isNaN(createdAt.getTime())) return;
    if (Date.now() - createdAt.getTime() > windowMinutes * 60 * 1000) return;

    const { data: workflows, error } = await supabase
      .from('workflow')
      .select('id, conditions')
      .eq('entity_type', entityType)
      .eq('tenant_id', record.tenant_id)
      .eq('trigger_type', 'record_create')
      .eq('is_active', true);
    if (error || !workflows || workflows.length === 0) return;

    const CUSTOM_TYPES = ['custom', 'member_custom', 'org_custom'];
    const candidates = workflows.filter(w =>
      Array.isArray(w.conditions) && w.conditions.some(c => CUSTOM_TYPES.includes(c?.field_type))
    );
    if (candidates.length === 0) return;

    // Exclude workflows that already executed for this record (any non-skipped
    // log). This is the duplicate guard for ALL trigger modes on this path.
    const candidateIds = candidates.map(w => w.id);
    const { data: logs } = await supabase
      .from('workflow_log')
      .select('workflow_id')
      .in('workflow_id', candidateIds)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .neq('status', 'skipped');
    const executed = new Set((logs || []).map(l => l.workflow_id));
    const toRecheck = candidateIds.filter(id => !executed.has(id));
    if (toRecheck.length === 0) return;

    console.log(`[Workflows] Re-checking ${toRecheck.length} record_create workflow(s) for ${entityType}:${entityId} after preference value save`);
    await triggerWorkflows(entityType, entityId, null, record, 'record_create', baseUrl, {
      onlyWorkflowIds: toRecheck,
      suppressSkipLog: true,
    });
  } catch (err) {
    console.error('[Workflows] recheckRecordCreateWorkflows error:', err.message);
  }
}

export async function triggerPreferenceWorkflows(entityType, entityId, fieldId, value, baseUrl, previousValue, context = {}) {
  const pendingConfirmations = [];
  const reverts = [];
  
  if (!supabase) return { pendingConfirmations, reverts };
  
  try {
    const table = entityType === 'organization' ? 'organization' : 'member';
    const { data: entity } = await supabase
      .from(table)
      .select('*')
      .eq('id', entityId)
      .single();
    
    const tenantId = entity?.tenant_id;
    
    if (!tenantId) {
      console.log(`[Workflows] No tenant_id available for ${entityType}:${entityId}, skipping preference workflow evaluation`);
      return { pendingConfirmations, reverts };
    }
    
    const { data: workflows } = await supabase
      .from('workflow')
      .select('*')
      .eq('entity_type', entityType)
      .in('trigger_type', ['field_change', 'record_update'])
      .eq('tenant_id', tenantId)
      .eq('is_active', true);

    if (!workflows || workflows.length === 0) return { pendingConfirmations, reverts };
    
    console.log(`[Workflows] Evaluating ${workflows.length} workflows for ${entityType} preference field ${fieldId}, incoming value="${value}", previousValue="${previousValue}" (tenant: ${tenantId})`);

    for (const workflow of workflows) {
      const cfg = workflow.trigger_config;
      const isRecordUpdate = workflow.trigger_type === 'record_update';
      console.log(`[Workflows] Checking workflow "${workflow.name}": trigger_type=${workflow.trigger_type}, cfg.field_id=${cfg?.field_id}, our fieldId=${fieldId}, cfg.field_type=${cfg?.field_type}`);

      if (isRecordUpdate) {
        console.log(`[Workflows] "${workflow.name}" is record_update - skipping trigger field matching, evaluating conditions`);
      } else {
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
      }

      // Task #3232: loop guard for workflow-initiated chains — a workflow
      // already in this chain must not run again (A -> B -> A / self-trigger).
      if (Array.isArray(context.chain?.visited) && context.chain.visited.includes(workflow.id)) {
        console.log(`[Workflows] Chain loop guard: "${workflow.name}" already ran in this chain - skipping`);
        await logChainGuardSkip(workflow, entityType, entityId, 'chain_loop_guard', context.chain);
        continue;
      }

      let allConditionsMet = true;
      const conditionResults = [];
      if (workflow.conditions && workflow.conditions.length > 0) {
        console.log(`[Workflows] Evaluating ${workflow.conditions.length} conditions for preference workflow ${workflow.name}`);
        
        for (let i = 0; i < workflow.conditions.length; i++) {
          const condition = workflow.conditions[i];
          let afterValue;
          let beforeValue;
          
          const fieldType = condition.field_type || 'core';
          const isMemberField = fieldType === 'core' || fieldType === 'member_core';
          const isOrgField = fieldType === 'org_core';
          const isMemberCustom = fieldType === 'custom' || fieldType === 'member_custom';
          const isOrgCustom = fieldType === 'org_custom';
          
          if (isMemberField) {
            afterValue = entity?.[condition.field_id];
          } else if (isOrgField) {
            if (entityType === 'organization') {
              afterValue = entity?.[condition.field_id];
            } else if (entity?.organization_id) {
              const { data: orgData } = await supabase
                .from('organization')
                .select('*')
                .eq('id', entity.organization_id)
                .single();
              afterValue = orgData?.[condition.field_id];
            }
          } else if (isMemberCustom) {
            const memberId = entityType === 'member' ? entityId : null;
            if (memberId) {
              if (condition.field_id === fieldId) {
                afterValue = value;
                beforeValue = previousValue;
              } else {
                const { data: prefValue } = await supabase
                  .from('member_preference_value')
                  .select('value')
                  .eq('member_id', memberId)
                  .eq('field_id', condition.field_id)
                  .single();
                afterValue = prefValue?.value;
              }
            }
          } else if (isOrgCustom) {
            const orgIdForCustomField = entityType === 'organization' ? entityId : entity?.organization_id;
            if (orgIdForCustomField) {
              if (condition.field_id === fieldId) {
                afterValue = value;
                beforeValue = previousValue;
              } else {
                const { data: prefValue } = await supabase
                  .from('organization_preference_value')
                  .select('value')
                  .eq('organization_id', orgIdForCustomField)
                  .eq('field_id', condition.field_id)
                  .single();
                afterValue = prefValue?.value;
              }
            }
          }
          
          const actualValue = String(afterValue ?? '');
          
          const conditionMet = evaluateConditionOperator(condition.operator, afterValue, condition.value, beforeValue);
          
          conditionResults.push({
            field_id: condition.field_id,
            operator: condition.operator,
            expected: condition.value,
            actual: actualValue,
            met: conditionMet
          });
          
          console.log(`[Workflows] Pref condition ${i}: field="${condition.field_id}", op="${condition.operator}", value="${condition.value}", actual="${actualValue}", before="${String(beforeValue ?? '')}", met=${conditionMet}`);
          
          if (i === 0) {
            allConditionsMet = conditionMet;
          } else {
            if (condition.logic === 'OR') {
              allConditionsMet = allConditionsMet || conditionMet;
            } else {
              allConditionsMet = allConditionsMet && conditionMet;
            }
          }
        }
        
        console.log(`[Workflows] Final allConditionsMet for preference workflow ${workflow.name}: ${allConditionsMet}`);
      }
      
      if (await checkOncePerRecord(workflow, entityType, entityId)) {
        console.log(`[Workflows] Skipping "${workflow.name}" - trigger_mode=once_per_record and already executed for entity ${entityId}`);
        continue;
      }
      
      // Task #3232: system-initiated changes (a workflow set the field) have
      // no human present to confirm — bypass the confirmation gate and run.
      if (!isRecordUpdate && cfg?.requires_confirmation && !context.systemInitiated) {
        console.log(`[Workflows] Workflow "${workflow.name}" requires user confirmation - adding to pending list (conditions_met=${allConditionsMet})`);
        const conditionSummaries = await buildConditionSummaries(workflow.conditions, workflow.tenant_id, entityType);
        const confirmationData = {
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          entity_type: entityType,
          entity_id: entityId,
          actions: await Promise.all((workflow.actions || []).map(a => buildActionSummary(a, workflow.tenant_id, { entityType, entityId, entityData: entity }))),
          conditions_met: allConditionsMet,
          condition_results: conditionResults.length > 0 ? conditionResults : undefined,
          condition_summaries: conditionSummaries.length > 0 ? conditionSummaries : undefined,
          revert_on_fail: workflow.revert_trigger_on_condition_fail || false,
          revert_field_id: fieldId,
          revert_field_type: 'custom',
          revert_previous_value: previousValue
        };
        pendingConfirmations.push(confirmationData);
        continue;
      }
      
      if (!allConditionsMet) {
        console.log(`[Workflows] Conditions not met for preference workflow: ${workflow.name} - SKIPPING`);
        
        if (!isRecordUpdate && workflow.revert_trigger_on_condition_fail && !reverts.some(r => r.field_id === fieldId)) {
          console.log(`[Workflows] Revert trigger enabled for "${workflow.name}" - reverting custom field ${fieldId} from "${value}" back to "${previousValue}"`);
          
          try {
            const prefTable = entityType === 'organization' ? 'organization_preference_value' : 'member_preference_value';
            const idCol = entityType === 'organization' ? 'organization_id' : 'member_id';
            
            const { error: revertError } = await supabase
              .from(prefTable)
              .update({ value: previousValue ?? null })
              .eq(idCol, entityId)
              .eq('field_id', fieldId);
              
            if (revertError) {
              console.error(`[Workflows] Failed to revert custom field ${fieldId}:`, revertError);
            } else {
              console.log(`[Workflows] Successfully reverted custom field ${fieldId} to "${previousValue}"`);
              reverts.push({
                workflow_name: workflow.name,
                field_id: fieldId,
                field_type: 'custom',
                reverted_from: value,
                reverted_to: previousValue,
                reason: `Conditions not met for workflow "${workflow.name}"`
              });
            }
          } catch (revertErr) {
            console.error(`[Workflows] Error reverting custom field trigger for "${workflow.name}":`, revertErr);
          }
        } else if (reverts.some(r => r.field_id === fieldId)) {
          console.log(`[Workflows] Field ${fieldId} already reverted by another workflow - skipping for "${workflow.name}"`);
        }
        
        continue;
      }
      
      console.log(`[Workflows] Executing workflow: ${workflow.name} (trigger_mode=${workflow.trigger_mode || 'every_time'})`);

      const entityTable = entityType === 'organization' ? 'organization' : 'member';
      const { data: entityData } = await supabase.from(entityTable).select('*').eq('id', entityId).single();
      
      const results = await executeWorkflowActions(workflow, entityType, entityId, entityData || {}, baseUrl, context);
      await logWorkflowExecution(workflow, entityType, entityId, { field_id: fieldId, value: value, trigger_type: 'field_change', ...(context.systemInitiated ? { system_initiated: true, ...(context.triggeredByWorkflow ? { triggered_by_workflow: context.triggeredByWorkflow } : {}) } : {}) }, results);
    }
  } catch (err) {
    console.error('[Workflows] Preference Error:', err.message, err.stack);
  }
  
  return { pendingConfirmations, reverts };
}

// Execute a workflow that was pending user confirmation
// Dry-run an email action: runs the full placeholder resolution pipeline without sending
// Returns the resolved subject, body, recipient info, and any role member list
export async function dryRunEmail(action, workflow, entityType, entityId, baseUrl) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }
  
  const tenantId = workflow.tenant_id;
  
  // Fetch entity data
  let entityData = null;
  if (entityType === 'organization') {
    const { data } = await supabase.from('organization').select('*').eq('id', entityId).single();
    entityData = data;
  } else if (entityType === 'member') {
    const { data } = await supabase.from('member').select('*').eq('id', entityId).single();
    entityData = data;
  } else if (entityType === 'job_posting') {
    const { data } = await supabase.from('job_posting').select('*').eq('id', entityId).single();
    entityData = data;
  }
  if (entityData && (entityData.first_name || entityData.last_name)) {
    entityData.recipient_name = `${entityData.first_name || ''} ${entityData.last_name || ''}`.trim();
  }
  
  if (!entityData) {
    return { success: false, error: `Could not find ${entityType} with id ${entityId}` };
  }
  
  // Get template or custom content
  let subject, body;
  const useTemplateMode = (action.config?.mode === 'template' || action.config?.template_id) && action.config?.template_id;
  if (useTemplateMode) {
    const { data: template } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', action.config.template_id)
      .single();
    if (!template) {
      return { success: false, error: 'Email template not found' };
    }
    subject = template.subject || '';
    body = template.body || '';
  } else {
    subject = action.config?.subject || '';
    body = action.config?.body || '';
  }
  
  // Check if role-based
  const toRoleIds = action.config?.to_role_ids || (action.config?.to_role_id ? [action.config.to_role_id] : []);
  const isRoleBased = action.config?.to_mode === 'role' && toRoleIds.length > 0;
  
  if (isRoleBased) {
    // Role-based: resolve for first member of the role
    const organizationId = await getOrganizationIdFromEntity(entityType, entityId, entityData);
    if (!organizationId) {
      return { success: false, error: 'Could not determine organization for role-based email' };
    }
    
    const membersByRole = await Promise.all(
      toRoleIds.map(roleId => getMembersByRoleInOrganization(roleId, organizationId))
    );
    const seenIds = new Set();
    const members = [];
    for (const roleMembers of membersByRole) {
      for (const member of roleMembers) {
        if (!seenIds.has(member.id)) {
          seenIds.add(member.id);
          members.push(member);
        }
      }
    }
    
    if (members.length === 0) {
      return { 
        success: true, 
        subject, 
        body, 
        is_role_based: true,
        recipients: [],
        warning: 'No members found with the selected role(s) in this organization'
      };
    }
    
    // Resolve placeholders for the first member as preview
    const member = members[0];
    
    // Pre-fetch org data for member-triggered workflows
    let triggerMemberOrgData = null;
    if (entityType === 'member' && entityData?.organization_id) {
      const { data: orgData } = await supabase.from('organization').select('*').eq('id', entityData.organization_id).single();
      triggerMemberOrgData = orgData;
    }
    
    // Step 1: Apply field mappings
    if (action.config?.field_mappings && Object.keys(action.config.field_mappings).length > 0) {
      if (entityType !== 'member') {
        subject = await applyFieldMappings(subject, action.config.field_mappings, entityType, entityId, entityData, true);
        body = await applyFieldMappings(body, action.config.field_mappings, entityType, entityId, entityData, true);
      } else if (triggerMemberOrgData) {
        subject = await applyFieldMappings(subject, action.config.field_mappings, 'organization', entityData.organization_id, triggerMemberOrgData, true);
        body = await applyFieldMappings(body, action.config.field_mappings, 'organization', entityData.organization_id, triggerMemberOrgData, true);
      }
      subject = await applyFieldMappings(subject, action.config.field_mappings, 'member', member.id, member, false);
      body = await applyFieldMappings(body, action.config.field_mappings, 'member', member.id, member, false);
    }
    
    // Step 2: Resolve UUID-style field ID placeholders
    subject = await resolveFieldIdPlaceholder(subject, 'member', member.id);
    body = await resolveFieldIdPlaceholder(body, 'member', member.id);
    
    // Step 3: Replace standard placeholders
    const memberPrefContext = member.id ? { tenantBaseUrl: baseUrl, tenantId, memberId: member.id } : null;
    subject = replacePlaceholders(subject, 'member', member, memberPrefContext);
    body = replacePlaceholders(body, 'member', member, memberPrefContext);
    subject = replacePlaceholders(subject, entityType, entityData, null);
    body = replacePlaceholders(body, entityType, entityData, null);
    if (entityType === 'member' && triggerMemberOrgData) {
      subject = replacePlaceholders(subject, 'organization', triggerMemberOrgData, null);
      body = replacePlaceholders(body, 'organization', triggerMemberOrgData, null);
    }
    
    // Step 4: Process special placeholders (skip actual URL generation for dry run)
    // Replace with placeholder text instead of generating real tokens
    subject = subject?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '[Password Setup URL will be generated]');
    body = body?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '[Password Setup URL will be generated]');
    subject = subject?.replace(/\[\[\s*set_password_url\s*\]\]/gi, '[Password Setup URL will be generated]');
    body = body?.replace(/\[\[\s*set_password_url\s*\]\]/gi, '[Password Setup URL will be generated]');
    
    // Detect any remaining unresolved placeholders
    const unresolved = collectUnresolvedPlaceholders(subject, body);
    
    return {
      success: true,
      subject,
      body,
      is_role_based: true,
      preview_member: { id: member.id, first_name: member.first_name, last_name: member.last_name, email: member.email },
      recipients: members.map(m => ({ id: m.id, first_name: m.first_name, last_name: m.last_name, email: m.email })),
      unresolved_placeholders: unresolved
    };
  } else {
    // Standard email: resolve for the entity
    
    // Apply field mappings (use preserveEmpty=true to keep unresolved placeholders visible in preview)
    if (action.config?.field_mappings && Object.keys(action.config.field_mappings).length > 0) {
      subject = await applyFieldMappings(subject, action.config.field_mappings, entityType, entityId, entityData, true);
      body = await applyFieldMappings(body, action.config.field_mappings, entityType, entityId, entityData, true);
    }
    
    // Resolve UUID-style field ID placeholders
    subject = await resolveFieldIdPlaceholder(subject, entityType, entityId);
    body = await resolveFieldIdPlaceholder(body, entityType, entityId);
    
    // Resolve recipient
    let toResolved = action.config?.to || '';
    if (action.config?.to_mode === 'field') {
      toResolved = await resolveFieldIdPlaceholder(toResolved, entityType, entityId);
    }
    const to = replacePlaceholders(toResolved, entityType, entityData);
    
    // Replace standard placeholders
    const prefContext = entityType === 'member' && entityId ? { tenantBaseUrl: baseUrl, tenantId, memberId: entityId } : null;
    subject = replacePlaceholders(subject, entityType, entityData, prefContext);
    body = replacePlaceholders(body, entityType, entityData, prefContext);
    
    // Special placeholder replacement (dry run - don't generate real tokens)
    subject = subject?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '[Password Setup URL will be generated]');
    body = body?.replace(/\{\{\s*set_password_url\s*\}\}/gi, '[Password Setup URL will be generated]');
    subject = subject?.replace(/\[\[\s*set_password_url\s*\]\]/gi, '[Password Setup URL will be generated]');
    body = body?.replace(/\[\[\s*set_password_url\s*\]\]/gi, '[Password Setup URL will be generated]');
    
    // Detect any remaining unresolved placeholders
    const unresolved = collectUnresolvedPlaceholders(subject, body);
    
    return {
      success: true,
      subject,
      body,
      is_role_based: false,
      to,
      unresolved_placeholders: unresolved
    };
  }
}

// Helper: collect any remaining {{...}} or [[...]] placeholders after resolution
function collectUnresolvedPlaceholders(subject, body) {
  const all = new Set();
  const curlyRegex = /\{\{([^}]+)\}\}/g;
  const bracketRegex = /\[\[([^\]]+)\]\]/g;
  
  for (const text of [subject, body]) {
    if (!text) continue;
    let match;
    while ((match = curlyRegex.exec(text)) !== null) {
      all.add(`{{${match[1]}}}`);
    }
    while ((match = bracketRegex.exec(text)) !== null) {
      all.add(`[[${match[1]}]]`);
    }
  }
  return Array.from(all);
}

export async function executeConfirmedWorkflow(workflowId, entityType, entityId, beforeData, afterData, baseUrl) {
  console.log(`[Workflows] executeConfirmedWorkflow called: workflowId=${workflowId}, entityType=${entityType}, entityId=${entityId}`);
  
  if (!supabase) {
    console.log(`[Workflows] No supabase client available`);
    return { success: false, error: 'Database not configured' };
  }
  
  try {
    // Fetch the workflow
    const { data: workflow, error: workflowError } = await supabase
      .from('workflow')
      .select('*')
      .eq('id', workflowId)
      .single();
    
    if (workflowError || !workflow) {
      console.error(`[Workflows] Failed to fetch workflow ${workflowId}:`, workflowError);
      return { success: false, error: 'Workflow not found' };
    }
    
    if (!workflow.is_active) {
      console.log(`[Workflows] Workflow ${workflowId} is not active`);
      return { success: false, error: 'Workflow is not active' };
    }
    
    // Check once per record limit
    if (await checkOncePerRecord(workflow, entityType, entityId)) {
      console.log(`[Workflows] Workflow "${workflow.name}" already executed for entity ${entityId}`);
      return { success: false, error: 'Workflow already executed for this record' };
    }
    
    console.log(`[Workflows] Executing confirmed workflow: ${workflow.name}`);
    
    // Get the current entity data if afterData is not provided
    let entityData = afterData;
    if (!entityData) {
      const table = entityType === 'job_posting' ? 'job_posting' : entityType;
      const { data } = await supabase.from(table).select('*').eq('id', entityId).single();
      entityData = data || {};
    }
    if (entityData && (entityData.first_name || entityData.last_name)) {
      entityData.recipient_name = `${entityData.first_name || ''} ${entityData.last_name || ''}`.trim();
    }
    
    const results = await executeWorkflowActions(workflow, entityType, entityId, entityData, baseUrl);
    await logWorkflowExecution(workflow, entityType, entityId, { 
      before: beforeData, 
      after: afterData, 
      trigger_type: 'field_change',
      confirmed_by_user: true 
    }, results);
    
    const hasFailures = results.some(r => r.status === 'failed');
    
    return { 
      success: !hasFailures, 
      results,
      workflow_name: workflow.name
    };
  } catch (err) {
    console.error('[Workflows] executeConfirmedWorkflow Error:', err.message, err.stack);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Scheduled workflows
// ---------------------------------------------------------------------------
// Scheduled workflows are not driven by a record change. Instead a cron sweep
// (api/cron/run-scheduled-workflows.js) calls runScheduledWorkflow for each
// active workflow whose trigger_type === 'scheduled' that is due to run. We
// iterate the workflow's entity records for its tenant, evaluate its
// conditions against the *current* value of each record (no before/after), and
// execute the actions for matching records. once_per_record vs every_time is
// honored via checkOncePerRecord exactly like the event-driven path.

// Resolve the current value of a single condition's field for a scheduled
// evaluation. Mirrors the field resolution used by triggerWorkflows but works
// off an already-loaded record and never has a "before" value.
async function resolveScheduledConditionValue(condition, entityType, record) {
  const fieldType = condition.field_type || 'core';

  // Member / job_posting core fields, and the generic "core" of whatever the
  // workflow entity is, live directly on the record.
  if (
    fieldType === 'job_posting_core' ||
    fieldType === 'member_core' ||
    fieldType === 'core'
  ) {
    return record?.[condition.field_id];
  }

  // Organisation core fields.
  if (fieldType === 'org_core') {
    if (entityType === 'organization') return record?.[condition.field_id];
    if (record?.organization_id) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('*')
        .eq('id', record.organization_id)
        .maybeSingle();
      return orgData?.[condition.field_id];
    }
    return undefined;
  }

  // Member custom (preference) values.
  if (fieldType === 'member_custom' || fieldType === 'custom') {
    if (!record?.id) return undefined;
    const { data: prefValue } = await supabase
      .from('member_preference_value')
      .select('value')
      .eq('member_id', record.id)
      .eq('field_id', condition.field_id)
      .maybeSingle();
    return prefValue?.value;
  }

  // Organisation custom (preference) values.
  if (fieldType === 'org_custom') {
    const orgId = entityType === 'organization' ? record?.id : record?.organization_id;
    if (!orgId) return undefined;
    const { data: prefValue } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', orgId)
      .eq('field_id', condition.field_id)
      .maybeSingle();
    return prefValue?.value;
  }

  return undefined;
}

// Evaluate all conditions of a scheduled workflow against one record. Honors
// the same AND/OR `logic` semantics as the event-driven path. A workflow with
// no conditions matches every record.
async function evaluateScheduledConditions(workflow, entityType, record) {
  const conditions = Array.isArray(workflow.conditions) ? workflow.conditions : [];
  if (conditions.length === 0) return true;

  let allConditionsMet = true;
  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    const afterValue = await resolveScheduledConditionValue(condition, entityType, record);
    const conditionMet = evaluateConditionOperator(condition.operator, afterValue, condition.value, undefined);

    if (i === 0) {
      allConditionsMet = conditionMet;
    } else if (condition.logic === 'OR') {
      allConditionsMet = allConditionsMet || conditionMet;
    } else {
      allConditionsMet = allConditionsMet && conditionMet;
    }
  }
  return allConditionsMet;
}

// Run a single scheduled workflow across its tenant's entity records.
// Returns a summary { evaluated, matched, executed, skipped, errors, complete, nextOffset }.
//
// Options (all optional; defaults preserve the hourly-cron behaviour):
//   recordLimit    — max records to process in THIS invocation (default 2000).
//   offset         — record offset to start from, for resumable chunked runs
//                    driven by the manual-backfill endpoint (default 0).
//   dryRun         — evaluate conditions and count matches but execute NO
//                    actions and write NO workflow_log rows (default false).
//   logTriggerType — trigger_type recorded in workflow_log trigger_data
//                    (default 'scheduled'; the manual backfill endpoint passes
//                    'manual_backfill' so manual runs are distinguishable).
//   budgetMs       — wall-clock budget for THIS invocation. When elapsed time
//                    reaches the budget the run stops cleanly BETWEEN records
//                    (never mid-record) and returns complete:false with
//                    nextOffset pointing at the first UNprocessed record.
//                    Needed because execute cost is driven by matched records
//                    (each match does several sequential awaits), so a
//                    record-count cap alone can blow the serverless
//                    maxDuration. Default: no budget (cron behaviour).
//
// `complete` is false when the invocation stopped at recordLimit or budgetMs
// with more records potentially remaining; `nextOffset` is the offset to
// resume from.
export async function runScheduledWorkflow(workflow, baseUrl, options = {}) {
  const summary = { evaluated: 0, matched: 0, executed: 0, skipped: 0, errors: 0, complete: true, nextOffset: null };
  if (!supabase) {
    console.error('[Workflows] runScheduledWorkflow: Supabase not configured');
    return summary;
  }

  const entityType = workflow.entity_type;
  const tenantId = workflow.tenant_id;
  if (!entityType || !tenantId) {
    console.warn(`[Workflows] runScheduledWorkflow: workflow ${workflow.id} missing entity_type or tenant_id`);
    return summary;
  }

  const table = entityType === 'job_posting' ? 'job_posting' : entityType;
  const recordLimit = Number.isFinite(options.recordLimit) ? options.recordLimit : 2000;
  const startOffset = Number.isFinite(options.offset) && options.offset > 0 ? Math.floor(options.offset) : 0;
  const dryRun = options.dryRun === true;
  const logTriggerType = options.logTriggerType || 'scheduled';
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : null;
  const startedAt = Date.now();
  const budgetExceeded = () => budgetMs !== null && (Date.now() - startedAt) >= budgetMs;
  const pageSize = 500;

  let from = startOffset;
  let processed = 0;
  let exhausted = false;
  let stoppedForBudget = false;
  while (processed < recordLimit) {
    if (budgetExceeded()) {
      stoppedForBudget = true;
      break;
    }
    const batchSize = Math.min(pageSize, recordLimit - processed);
    const to = from + batchSize - 1;
    // ORDER BY is required for stable .range() pagination — without it
    // PostgREST may skip/repeat rows across pages.
    const { data: records, error } = await supabase
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) {
      console.error(`[Workflows] runScheduledWorkflow: failed to load ${table} page for tenant ${tenantId}: ${error.message}`);
      summary.errors++;
      break;
    }
    if (!records || records.length === 0) {
      exhausted = true;
      break;
    }

    // Track how many records of THIS page were fully processed so a
    // budget-stop mid-page can resume at the exact next record (the old
    // implementation only advanced `from` at page boundaries).
    let processedInPage = 0;
    for (const record of records) {
      if (budgetExceeded()) {
        stoppedForBudget = true;
        break;
      }
      summary.evaluated++;
      processed++;
      processedInPage++;
      try {
        // Cheap skip: a once_per_record workflow that already ran for this
        // record needs no condition evaluation at all.
        if (await checkOncePerRecord(workflow, entityType, record.id)) {
          summary.skipped++;
          continue;
        }

        const matched = await evaluateScheduledConditions(workflow, entityType, record);
        if (!matched) continue;
        summary.matched++;

        if (dryRun) continue;

        const entityData = { ...record };
        if (entityData.first_name || entityData.last_name) {
          entityData.recipient_name = `${entityData.first_name || ''} ${entityData.last_name || ''}`.trim();
        }

        const results = await executeWorkflowActions(workflow, entityType, record.id, entityData, baseUrl);
        await logWorkflowExecution(workflow, entityType, record.id, {
          trigger_type: logTriggerType,
          scheduled_at: new Date().toISOString(),
        }, results);
        summary.executed++;
      } catch (err) {
        summary.errors++;
        console.error(`[Workflows] runScheduledWorkflow: error processing ${entityType} ${record.id}: ${err.message}`);
      }
    }

    from += processedInPage;
    if (stoppedForBudget) {
      break;
    }
    if (records.length < batchSize) {
      exhausted = true;
      break;
    }
  }

  if (stoppedForBudget || (!exhausted && processed >= recordLimit)) {
    summary.complete = false;
    summary.nextOffset = from;
  }

  console.log(`[Workflows] runScheduledWorkflow "${workflow.name}" (${workflow.id})${dryRun ? ' [dry-run]' : ''}: ${JSON.stringify(summary)}`);
  return summary;
}

// Return the list of condition operators in a workflow that cannot be
// evaluated without a "before" value (change-based operators). Used by the
// manual backfill endpoint to reject workflows whose conditions are
// meaningless in a current-state-only evaluation.
export function getChangeBasedConditionOperators(workflow) {
  const conditions = Array.isArray(workflow?.conditions) ? workflow.conditions : [];
  const changeOps = new Set(['changed_to', 'changed_from']);
  return conditions
    .map(c => c?.operator)
    .filter(op => changeOps.has(op));
}

// Decide whether a scheduled workflow is due to run at the given evaluation
// time. Schedule config lives in trigger_config:
//   { frequency: 'hourly' | 'daily', run_time: 'HH:MM' }  (UTC)
// - hourly: due on every sweep.
// - daily (default): due only when the current UTC hour matches run_time's
//   hour. Defaults to hour 0 (00:00 UTC) when run_time is absent/invalid.
export function isScheduledWorkflowDue(workflow, now = new Date()) {
  const cfg = workflow?.trigger_config || {};
  const frequency = cfg.frequency || 'daily';
  if (frequency === 'hourly') return true;

  // daily (and any unknown frequency treated as daily)
  let targetHour = 0;
  if (typeof cfg.run_time === 'string' && /^\d{1,2}:\d{2}$/.test(cfg.run_time)) {
    const parsedHour = parseInt(cfg.run_time.split(':')[0], 10);
    if (Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      targetHour = parsedHour;
    }
  }
  return now.getUTCHours() === targetHour;
}
