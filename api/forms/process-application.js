import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { sendEmail } from '../_lib/emailService.js';
import { triggerWorkflows } from '../_lib/workflows.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Fields that should be coerced to boolean values
const BOOLEAN_CORE_FIELDS = ['show_in_directory', 'login_enabled'];

// Helper function to check if a value is "empty" (undefined, null, or empty string)
const isEmptyValue = (value) => value === undefined || value === null || value === '';

// Helper function to check if a field has a usable value for assignment
// For boolean fields, we ALWAYS assign (even undefined means false - toggle was off)
const hasAssignableValue = (fieldName, value) => {
  if (BOOLEAN_CORE_FIELDS.includes(fieldName)) {
    // For boolean fields, always return true - if a mapping exists, we should assign
    // Undefined/null/empty will be coerced to false by coerceBooleanField
    return true;
  }
  // For non-boolean fields, skip empty values
  return !isEmptyValue(value);
};

// Helper function to coerce values to boolean for boolean fields
const coerceBooleanField = (fieldName, value) => {
  if (!BOOLEAN_CORE_FIELDS.includes(fieldName)) {
    return value;
  }
  // Already a boolean
  if (typeof value === 'boolean') {
    return value;
  }
  // Handle undefined, null, or empty string as false
  if (value === undefined || value === null || value === '') {
    return false;
  }
  // Handle string representations
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false;
    }
  }
  // Handle numeric values
  if (typeof value === 'number') {
    return value !== 0;
  }
  // Default: treat as false for boolean fields
  return false;
};

// Helper function to apply value transformations
const applyTransformation = (value, transformation) => {
  if (value === null || value === undefined) return value;
  const strValue = String(value);
  
  switch (transformation) {
    case 'trim':
      return strValue.trim();
    case 'uppercase':
      return strValue.toUpperCase();
    case 'lowercase':
      return strValue.toLowerCase();
    case 'titlecase':
      return strValue.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    case 'extract_domain':
      if (strValue.includes('@')) {
        return strValue.split('@')[1] || strValue;
      }
      return strValue;
    case 'extract_username':
      if (strValue.includes('@')) {
        return strValue.split('@')[0] || strValue;
      }
      return strValue;
    case 'first_word':
      return strValue.trim().split(/\s+/)[0] || strValue;
    case 'last_word':
      const words = strValue.trim().split(/\s+/);
      return words[words.length - 1] || strValue;
    case 'remove_spaces':
      return strValue.replace(/\s+/g, '');
    case 'numbers_only':
      return strValue.replace(/[^0-9]/g, '');
    case 'current_date':
      return new Date().toISOString().split('T')[0]; // Returns YYYY-MM-DD format
    case 'none':
    default:
      return strValue;
  }
};

// Helper function to check role capacity for per-organization limits
const checkRoleCapacity = async (supabaseClient, roleId, organizationId) => {
  console.log('[checkRoleCapacity] Checking capacity for role:', roleId, 'org:', organizationId);
  
  // Fetch role to check if it has max_members limit
  const { data: role, error: roleError } = await supabaseClient
    .from('role')
    .select('id, name, max_members')
    .eq('id', roleId)
    .single();
  
  if (roleError) {
    console.error('[checkRoleCapacity] Failed to fetch role:', roleError);
    return { hasCapacity: true, error: roleError.message };
  }
  
  if (!role) {
    console.log('[checkRoleCapacity] Role not found:', roleId);
    return { hasCapacity: true, error: 'Role not found' };
  }
  
  // If no max_members limit, allow
  if (!role.max_members) {
    console.log('[checkRoleCapacity] No max_members limit for role:', role.name);
    return { hasCapacity: true, maxMembers: null, roleName: role.name };
  }
  
  // Role capacity is ALWAYS per-organization - no global fallback
  if (!organizationId) {
    console.log('[checkRoleCapacity] Organization required for capacity check');
    return { 
      hasCapacity: false, 
      maxMembers: role.max_members, 
      roleName: role.name,
      missingOrgContext: true,
      error: 'Organization context required for per-organization capacity check'
    };
  }
  
  // Count active members with this role in this organization
  const { count, error: countError } = await supabaseClient
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('role_id', roleId)
    .eq('organization_id', organizationId)
    .eq('login_enabled', true);
  
  if (countError) {
    console.error('[checkRoleCapacity] Failed to count members:', countError);
    return { hasCapacity: true, error: countError.message };
  }
  
  const currentCount = count || 0;
  const hasCapacity = currentCount < role.max_members;
  
  console.log('[checkRoleCapacity] Per-org capacity check:', {
    roleId,
    roleName: role.name,
    organizationId,
    currentCount,
    maxMembers: role.max_members,
    hasCapacity
  });
  
  return {
    hasCapacity,
    currentCount,
    maxMembers: role.max_members,
    roleName: role.name
  };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { 
      form_id,
      form_values,
      fields,
      field_mappings,
      application_level,
      create_entity_type,
      entity_action,
      member_entity_action,        // Legacy: independent member action (none/create/update/upsert)
      organization_entity_action,  // Legacy: independent organization action (none/create/update/upsert)
      prefill_member_id,
      prefill_organization_id,
      submission_id,
      role_id,                     // Role ID from form conditional logic (set_role action)
      additional_member_creations, // Legacy: Array of additional members to create
      entity_pipelines,            // New unified structure: {members: [], organisations: []}
      tenant_id                    // Tenant ID for multi-tenant isolation (from public API)
    } = req.body;

    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'form_values is required' });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields array is required' });
    }

    // Normalize entity_pipelines to work with both new and legacy formats
    const memberPipelines = entity_pipelines?.members || [];
    const orgPipelines = entity_pipelines?.organisations || [];
    
    console.log('[AppProcessor] Entity pipelines - members:', memberPipelines.length, 'organisations:', orgPipelines.length);
    
    // Debug: Log all field IDs in form_values to help diagnose missing fields
    console.log('[AppProcessor] Form values - all field IDs present:', Object.keys(form_values));
    console.log('[AppProcessor] Form values sample (first 5 entries):', 
      Object.entries(form_values).slice(0, 5).map(([k, v]) => `${k}=${JSON.stringify(v)?.substring(0, 50)}`));
    
    // Determine if we should process members/orgs based on new entity_pipelines structure
    // If entity_pipelines is provided, use that exclusively; otherwise fall back to legacy fields
    const validActions = ['none', 'create', 'update', 'upsert'];
    const hasEntityPipelinesConfig = entity_pipelines !== undefined && entity_pipelines !== null;
    
    let memberAction;
    let orgAction;
    
    if (hasEntityPipelinesConfig) {
      // New entity_pipelines system - if provided, use it exclusively
      // If member pipelines exist, use 'upsert'; otherwise 'none' (no member processing)
      memberAction = memberPipelines.length > 0 ? 'upsert' : 'none';
    } else if (member_entity_action && validActions.includes(member_entity_action)) {
      memberAction = member_entity_action;
    } else {
      // Legacy fallback (only when entity_pipelines is not provided)
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'member' || legacyEntityType === 'both') {
        memberAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        memberAction = 'none';
      }
    }
    
    if (hasEntityPipelinesConfig) {
      // New entity_pipelines system - if provided, use it exclusively
      // If org pipelines exist, use 'upsert'; otherwise 'none' (no org processing)
      orgAction = orgPipelines.length > 0 ? 'upsert' : 'none';
    } else if (organization_entity_action && validActions.includes(organization_entity_action)) {
      orgAction = organization_entity_action;
    } else {
      // Legacy fallback (only when entity_pipelines is not provided)
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'organization' || legacyEntityType === 'both') {
        orgAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        orgAction = 'none';
      }
    }
    
    // Determine processing flags based on action values
    const shouldProcessMember = memberAction !== 'none';
    const shouldProcessOrganization = orgAction !== 'none';
    const isUpdateMode = orgAction === 'update'; // For org logic compatibility
    const isMemberUpdateMode = memberAction === 'update';
    
    console.log('[AppProcessor] Entity actions - member:', memberAction, 'organization:', orgAction);
    console.log('[AppProcessor] Received role_id:', role_id, 'type:', typeof role_id);

    // Idempotency check: if submission_id provided, check if already processed
    if (submission_id) {
      const { data: existingSubmission } = await supabase
        .from('form_submission')
        .select('created_member_id, created_organization_id, processed_at')
        .eq('id', submission_id)
        .single();

      if (existingSubmission?.processed_at) {
        console.log('[AppProcessor] Submission already processed:', submission_id);
        return res.json({
          success: true,
          already_processed: true,
          created_member_id: existingSubmission.created_member_id,
          created_organization_id: existingSubmission.created_organization_id
        });
      }
    }

    // SERVER-SIDE UNIQUENESS VALIDATION (defense in depth)
    // This blocks duplicates even if client-side validation is bypassed
    // Skip for update modes with prefill IDs (those are legitimate self-updates)
    const isCreatingNewEntities = !prefill_member_id && !prefill_organization_id;
    
    if (form_id && isCreatingNewEntities) {
      const { data: formData } = await supabase
        .from('form')
        .select('uniqueness_checks, tenant_id')
        .eq('id', form_id)
        .single();
      
      if (formData?.uniqueness_checks && Array.isArray(formData.uniqueness_checks) && formData.uniqueness_checks.length > 0) {
        const effectiveTenantId = tenant_id || formData.tenant_id;
        console.log('[AppProcessor] Running server-side uniqueness validation, tenant_id:', effectiveTenantId);
        
        const conflicts = [];
        const validFieldIds = new Set((fields || []).filter(f => f && f.id).map(f => f.id));
        
        for (const check of formData.uniqueness_checks) {
          if (!check || !check.field_id || !validFieldIds.has(check.field_id)) continue;
          
          const field = fields.find(f => f && f.id === check.field_id);
          if (!field) continue;
          
          const value = form_values[check.field_id];
          if (!value) continue;
          
          const targetField = check.target_field;
          if (!targetField || !targetField.includes('.')) continue;
          
          const [targetEntity, targetColumn] = targetField.split('.');
          const tableName = targetEntity === 'organization' ? 'organization' : 'member';
          
          // Validate target column against whitelist
          const validColumns = {
            member: ['email', 'full_name', 'phone'],
            organization: ['name', 'invoicing_email', 'phone', 'website_url']
          };
          if (!validColumns[tableName]?.includes(targetColumn)) continue;
          
          // Escape SQL wildcards for safe ilike usage
          const searchValue = String(value).trim().replace(/[%_]/g, '\\$&');
          const mode = check.comparison_mode || 'equals_lowercase';
          
          // Build query based on comparison mode
          let query = supabase.from(tableName).select('id', { count: 'exact', head: true });
          
          if (mode === 'equals') {
            query = query.eq(targetColumn, searchValue);
          } else if (mode === 'contains') {
            query = query.ilike(targetColumn, `%${searchValue}%`);
          } else if (mode === 'starts_with') {
            query = query.ilike(targetColumn, `${searchValue}%`);
          } else if (mode === 'ends_with') {
            query = query.ilike(targetColumn, `%${searchValue}`);
          } else {
            // Default: equals_lowercase (case insensitive exact match)
            query = query.ilike(targetColumn, searchValue);
          }
          
          // Add tenant filtering
          if (effectiveTenantId) {
            query = query.eq('tenant_id', effectiveTenantId);
          }
          
          const { count } = await query;
          
          if (count && count > 0) {
            const entityLabel = tableName === 'organization' ? 'an organisation' : 'a member';
            conflicts.push({
              field_id: check.field_id,
              field_label: field.label || check.field_id,
              message: `We already have ${entityLabel} registered with this value.`
            });
          }
        }
        
        if (conflicts.length > 0) {
          console.log('[AppProcessor] Server-side uniqueness check BLOCKED submission:', conflicts);
          return res.status(409).json({
            valid: false,
            error: 'Uniqueness validation failed',
            conflicts,
            code: 'UNIQUENESS_CONFLICT'
          });
        }
        
        console.log('[AppProcessor] Server-side uniqueness check passed');
      }
    }

    const memberData = {};
    const orgData = {};
    // Use Maps to aggregate values for list fields
    const memberCustomFieldsMap = new Map();
    const orgCustomFieldsMap = new Map();
    // Map to collect communication preferences (categoryId -> boolean subscribed value)
    const memberCommunicationPrefsMap = new Map();

    const { data: preferenceFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('is_active', true);

    const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));

    // Helper to add value to custom field map (aggregates for list fields)
    const addCustomFieldValue = (map, fieldId, value, prefField) => {
      const isListField = prefField?.field_type === 'list';
      
      if (isListField) {
        // Aggregate values into an array for list fields
        if (!map.has(fieldId)) {
          map.set(fieldId, []);
        }
        const arr = map.get(fieldId);
        
        // Handle array values (from multi-select checkboxes)
        if (Array.isArray(value)) {
          for (const item of value) {
            // Add each item if not already present (dedupe)
            if (!arr.includes(item)) {
              arr.push(item);
            }
          }
        } else {
          // Add single value if not already present (dedupe)
          if (!arr.includes(value)) {
            arr.push(value);
          }
        }
      } else {
        // For non-list fields, just store the value (last one wins)
        // If value is an array, store it as-is (will be JSON stringified later)
        map.set(fieldId, value);
      }
    };

    // Build set of fields that are explicitly mapped in entity_pipelines Primary Member
    // These fields should NOT be populated by legacy field_mappings (entity_pipelines takes precedence)
    const pipelineMemberFields = new Set();
    const pipelineOrgFields = new Set();
    
    if (memberPipelines.length > 0) {
      const primaryMemberPipeline = memberPipelines.find(m => m.isPrimary);
      if (primaryMemberPipeline?.mappings && Array.isArray(primaryMemberPipeline.mappings)) {
        for (const m of primaryMemberPipeline.mappings) {
          if (m.target_type === 'core' && m.target_field) {
            pipelineMemberFields.add(m.target_field);
          }
        }
      }
    }
    
    if (orgPipelines.length > 0) {
      const primaryOrgPipeline = orgPipelines.find(o => o.isPrimary);
      if (primaryOrgPipeline?.mappings && Array.isArray(primaryOrgPipeline.mappings)) {
        for (const m of primaryOrgPipeline.mappings) {
          if (m.target_type === 'core' && m.target_field) {
            pipelineOrgFields.add(m.target_field);
          }
        }
      }
    }
    
    console.log('[AppProcessor] Entity pipeline fields to skip in legacy field_mappings - member:', [...pipelineMemberFields], 'org:', [...pipelineOrgFields]);
    
    // Process new field_mappings array first (preferred method)
    // Skip fields that are mapped in entity_pipelines (those take precedence even if undefined)
    if (field_mappings && Array.isArray(field_mappings) && field_mappings.length > 0) {
      console.log('[AppProcessor] Using field_mappings:', field_mappings.length, 'mappings');
      
      for (const mapping of field_mappings) {
        const { source_type, source_field_id, static_value, target_type, target_entity, target_field, transformation } = mapping;
        
        // Skip if no target field
        if (!target_field) continue;
        
        // Skip if this core field is mapped in entity_pipelines (takes precedence)
        if (target_type === 'core') {
          if (target_entity === 'member' && pipelineMemberFields.has(target_field)) {
            console.log('[AppProcessor] Skipping legacy field_mappings for member field (entity_pipelines takes precedence):', target_field);
            continue;
          }
          if (target_entity === 'organization' && pipelineOrgFields.has(target_field)) {
            console.log('[AppProcessor] Skipping legacy field_mappings for org field (entity_pipelines takes precedence):', target_field);
            continue;
          }
        }
        
        let value;
        
        // Handle current_date transformation first - it doesn't need a source value
        if (transformation === 'current_date') {
          value = applyTransformation('', transformation);
          console.log('[AppProcessor] Current date mapping:', target_field, '=', value);
        } else if (source_type === 'static') {
          // Static value mapping - use the fixed value
          value = static_value;
          if (value === undefined || value === null || value === '') continue;
          console.log('[AppProcessor] Static mapping:', target_field, '=', value);
        } else {
          // Form field mapping (default)
          if (!source_field_id) continue;
          value = form_values[source_field_id];
          
          // For boolean fields in member entities, allow empty/false through (they mean false)
          const isMemberBooleanField = target_type === 'core' && target_entity === 'member' && BOOLEAN_CORE_FIELDS.includes(target_field);
          if (!isMemberBooleanField && (value === undefined || value === null || value === '')) continue;
          
          // Apply transformation only for field mappings
          if (transformation && transformation !== 'none') {
            value = applyTransformation(value, transformation);
          }
        }
        
        if (target_type === 'core') {
          if (target_entity === 'member') {
            // Use hasAssignableValue to properly handle boolean fields
            if (hasAssignableValue(target_field, value)) {
              memberData[target_field] = coerceBooleanField(target_field, value);
            }
          } else if (target_entity === 'organization') {
            orgData[target_field] = value;
          }
        } else if (target_type === 'custom') {
          const prefField = prefFieldMap.get(target_field);
          if (target_entity === 'organization') {
            addCustomFieldValue(orgCustomFieldsMap, target_field, value, prefField);
          } else {
            addCustomFieldValue(memberCustomFieldsMap, target_field, value, prefField);
          }
        }
      }
    } else {
      // Fallback: Use legacy core_field_mapping and custom_field_id on fields
      for (const field of fields) {
        const value = form_values[field.id];
        
        // Check if this is a boolean member core field - allow empty/false through
        let isMemberBooleanField = false;
        if (field.core_field_mapping) {
          const [entity, fieldName] = field.core_field_mapping.split('.');
          isMemberBooleanField = entity === 'member' && BOOLEAN_CORE_FIELDS.includes(fieldName);
        }
        
        // For non-boolean fields, skip empty values
        if (!isMemberBooleanField && (value === undefined || value === null || value === '')) continue;

        if (field.core_field_mapping) {
          const [entity, fieldName] = field.core_field_mapping.split('.');
          if (entity === 'member') {
            // Use hasAssignableValue to properly handle boolean fields
            if (hasAssignableValue(fieldName, value)) {
              memberData[fieldName] = coerceBooleanField(fieldName, value);
            }
          } else if (entity === 'organization') {
            orgData[fieldName] = value;
          }
        }

        if (field.custom_field_id) {
          const customField = prefFieldMap.get(field.custom_field_id);
          if (customField) {
            if (customField.entity_scope === 'organization') {
              addCustomFieldValue(orgCustomFieldsMap, customField.id, value, customField);
            } else {
              addCustomFieldValue(memberCustomFieldsMap, customField.id, value, customField);
            }
          }
        }
      }
    }

    // Convert maps to arrays for insertion, stringifying values appropriately
    const convertMapToArray = (map) => {
      const result = [];
      for (const [fieldId, value] of map.entries()) {
        let storedValue;
        if (Array.isArray(value)) {
          storedValue = JSON.stringify(value);
        } else if (typeof value === 'object') {
          storedValue = JSON.stringify(value);
        } else {
          storedValue = String(value);
        }
        result.push({ field_id: fieldId, value: storedValue });
      }
      return result;
    };

    let memberCustomFields = convertMapToArray(memberCustomFieldsMap);

    // Helper function to process pipeline entry mappings (supports both new array format and legacy object format)
    const processPipelineMappings = (pipelineEntry, targetEntity, dataObj, customFieldsMap, coreFieldMappingConfig) => {
      if (!pipelineEntry) return;
      
      // Check for new mappings array format first
      if (pipelineEntry.mappings && Array.isArray(pipelineEntry.mappings)) {
        console.log(`[AppProcessor] Processing ${targetEntity} from entity_pipelines (new format):`, pipelineEntry.label, 'mappings:', pipelineEntry.mappings.length);
        console.log(`[AppProcessor] ${pipelineEntry.label} mappings detail:`, JSON.stringify(pipelineEntry.mappings, null, 2));
        
        // Log form values for each mapping to debug
        console.log(`[AppProcessor] Form values for ${pipelineEntry.label}:`);
        for (const m of pipelineEntry.mappings) {
          if (m.source_field_id) {
            console.log(`  - ${m.target_field}: form_values["${m.source_field_id}"] = "${form_values[m.source_field_id]}"`);
          }
        }
        
        for (const mapping of pipelineEntry.mappings) {
          if (!mapping.target_field) continue;
          
          // Get value from form or static value
          let value;
          if (mapping.source_type === 'static') {
            value = mapping.static_value;
          } else if (mapping.transformation === 'current_date') {
            value = new Date().toISOString().split('T')[0];
          } else if (mapping.source_field_id) {
            value = form_values[mapping.source_field_id];
          }
          
          // Handle __clear__ sentinel value
          if (value === '__clear__') {
            if (mapping.target_type === 'core') {
              const dbKey = coreFieldMappingConfig[mapping.target_field] || mapping.target_field;
              dataObj[dbKey] = null;
            } else if (mapping.target_type === 'custom') {
              customFieldsMap.delete(mapping.target_field);
            }
            continue;
          }
          
          // Apply transformation
          if (value !== undefined && value !== null && mapping.transformation && mapping.transformation !== 'none') {
            value = applyTransformation(value, mapping.transformation);
          }
          
          if (mapping.target_type === 'core') {
            // Map to database field name using config
            const dbKey = coreFieldMappingConfig[mapping.target_field] || mapping.target_field;
            // Use hasAssignableValue to allow boolean false/empty through for boolean fields
            if (hasAssignableValue(dbKey, value)) {
              // Coerce boolean fields for member entities
              dataObj[dbKey] = targetEntity === 'member' ? coerceBooleanField(dbKey, value) : value;
            }
          } else if (mapping.target_type === 'custom') {
            // Custom field
            const customFieldId = mapping.target_field;
            const prefField = prefFieldMap.get(customFieldId);
            const hasValue = value !== undefined && value !== null && value !== '';
            const skipReason = value === undefined ? 'undefined' : value === null ? 'null' : value === '' ? 'empty string' : null;
            console.log(`[AppProcessor] Custom field mapping: target=${customFieldId}, source=${mapping.source_field_id}, value=${JSON.stringify(value)}, hasValue=${hasValue}${skipReason ? `, skipReason=${skipReason}` : ''}`);
            if (hasValue) {
              addCustomFieldValue(customFieldsMap, customFieldId, value, prefField);
              console.log(`[AppProcessor] Added custom field value: ${customFieldId} = "${value}"`);
            } else {
              console.log(`[AppProcessor] Skipped custom field: ${customFieldId} (reason: ${skipReason})`);
            }
          } else if (mapping.target_type === 'communication' && targetEntity === 'member') {
            // Communication preference (marketing list subscription)
            const categoryId = mapping.target_field;
            // Coerce value to boolean - truthy values mean subscribed
            let isSubscribed = false;
            if (typeof value === 'boolean') {
              isSubscribed = value;
            } else if (typeof value === 'string') {
              const lower = value.toLowerCase().trim();
              isSubscribed = lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on';
            } else if (typeof value === 'number') {
              isSubscribed = value !== 0;
            } else if (value) {
              isSubscribed = true;
            }
            console.log(`[AppProcessor] Communication preference mapping: category=${categoryId}, rawValue=${JSON.stringify(value)}, subscribed=${isSubscribed}`);
            memberCommunicationPrefsMap.set(categoryId, isSubscribed);
          }
        }
        
        return;
      }
      
      // Fall back to legacy field_mappings object format ONLY if no mappings array
      // This ensures we don't process both formats for the same entry
      if (!pipelineEntry.mappings && pipelineEntry.field_mappings) {
        console.log(`[AppProcessor] Processing ${targetEntity} from entity_pipelines (legacy format):`, pipelineEntry.label);
        
        for (const [configKey, dbKey] of Object.entries(coreFieldMappingConfig)) {
          const fieldId = pipelineEntry.field_mappings[configKey];
          if (!fieldId) continue;
          
          if (fieldId === '__clear__') {
            dataObj[dbKey] = null;
          } else {
            const val = form_values[fieldId];
            // Use hasAssignableValue to allow boolean false/empty through for boolean fields
            if (hasAssignableValue(dbKey, val)) {
              // Coerce boolean fields for member entities
              dataObj[dbKey] = targetEntity === 'member' ? coerceBooleanField(dbKey, val) : val;
            }
          }
        }
        
        // Process custom fields from legacy format
        const pipelineCustomMappings = Object.entries(pipelineEntry.field_mappings)
          .filter(([key]) => key.startsWith('custom_'));
        
        for (const [key, fieldId] of pipelineCustomMappings) {
          if (!fieldId) continue;
          const customFieldId = key.replace('custom_', '');
          const prefField = prefFieldMap.get(customFieldId);
          
          if (fieldId === '__clear__') {
            customFieldsMap.delete(customFieldId);
          } else {
            const val = form_values[fieldId];
            if (val !== undefined && val !== null && val !== '') {
              addCustomFieldValue(customFieldsMap, customFieldId, val, prefField);
            }
          }
        }
      }
    };

    // Process entity_pipelines primary entries if available (new unified system)
    // This supplements/overrides the field_mappings data
    if (memberPipelines.length > 0) {
      // Support both isPrimary (camelCase) and is_primary (snake_case) for compatibility
      const primaryMemberPipeline = memberPipelines.find(m => m.isPrimary || m.is_primary);
      console.log('[AppProcessor] Member pipelines:', memberPipelines.length, 'Primary found:', !!primaryMemberPipeline);
      const memberCoreFieldMappings = {
        'email': 'email',
        'first_name': 'first_name',
        'last_name': 'last_name',
        'phone': 'mobile',
        'job_title': 'job_title',
        'mobile': 'mobile',
        'landline': 'landline',
        'organization_id': 'organization_id',
        'show_in_directory': 'show_in_directory'
      };
      
      processPipelineMappings(primaryMemberPipeline, 'member', memberData, memberCustomFieldsMap, memberCoreFieldMappings);
      
      // If pipeline has a role_id, use it
      if (primaryMemberPipeline?.role_id) {
        if (primaryMemberPipeline.role_id === '__clear__') {
          memberData.role_id = null;
        } else {
          memberData.role_id = primaryMemberPipeline.role_id;
        }
        console.log('[AppProcessor] Using pipeline role_id:', memberData.role_id);
      }
      
      // If pipeline has login_enabled setting, use it (default to true if not specified)
      if (primaryMemberPipeline && primaryMemberPipeline.login_enabled !== undefined) {
        memberData.login_enabled = primaryMemberPipeline.login_enabled;
        console.log('[AppProcessor] Using pipeline login_enabled:', memberData.login_enabled);
      } else {
        memberData.login_enabled = true; // Default to true if not specified
      }
      
      // Re-convert custom fields after pipeline processing
      memberCustomFields = convertMapToArray(memberCustomFieldsMap);
    }
    
    // Process entity_pipelines primary organisation if available
    let orgCustomFields = convertMapToArray(orgCustomFieldsMap);
    if (orgPipelines.length > 0) {
      // Support both isPrimary (camelCase) and is_primary (snake_case) for compatibility
      const primaryOrgPipeline = orgPipelines.find(o => o.isPrimary || o.is_primary);
      console.log('[AppProcessor] Org pipelines:', orgPipelines.length, 'Primary found:', !!primaryOrgPipeline);
      if (primaryOrgPipeline) {
        console.log('[AppProcessor] Primary org pipeline mappings:', JSON.stringify(primaryOrgPipeline.mappings, null, 2));
      }
      const orgCoreFieldMappings = {
        'name': 'name',
        'email': 'email',
        'phone': 'phone',
        'website': 'website',
        'address': 'address'
      };
      
      processPipelineMappings(primaryOrgPipeline, 'organization', orgData, orgCustomFieldsMap, orgCoreFieldMappings);
      
      // Re-convert custom fields after pipeline processing
      orgCustomFields = convertMapToArray(orgCustomFieldsMap);
    }

    console.log('[AppProcessor] Extracted data:', { memberData, orgData, memberCustomFields: memberCustomFields.length, orgCustomFields: orgCustomFields.length, orgCustomFieldsDetail: orgCustomFields });

    let createdOrganizationId = null;
    let newlyCreatedOrgData = null; // Track org data for workflow trigger after custom fields saved
    let createdMemberId = null;

    // Process organization based on orgAction (none/create/update/upsert)
    if (shouldProcessOrganization) {
      console.log('[AppProcessor] Org processing enabled. Action:', orgAction, 'OrgData:', orgData, 'PrefillOrgId:', prefill_organization_id);
      
      // Find existing organization: by prefill_organization_id first, then by name
      let existingOrg = null;
      
      if (prefill_organization_id) {
        const { data: foundOrg } = await supabase
          .from('organization')
          .select('*')
          .eq('id', prefill_organization_id)
          .single();
        existingOrg = foundOrg;
        console.log('[AppProcessor] Found org by prefill ID:', existingOrg?.id);
      } else if (orgData.name) {
        const { data: foundOrg } = await supabase
          .from('organization')
          .select('*')
          .ilike('name', orgData.name)
          .limit(1)
          .single();
        existingOrg = foundOrg;
        console.log('[AppProcessor] Found org by name:', existingOrg?.id);
      }
      
      if (existingOrg) {
        // Organization exists
        if (orgAction === 'create') {
          // Create mode but org exists - skip creation, use existing ID
          console.log('[AppProcessor] Organization exists, skipping create (create mode):', existingOrg.id);
          createdOrganizationId = existingOrg.id;
        } else if (orgAction === 'update' || orgAction === 'upsert') {
          // Update existing organization
          const orgUpdateData = {};
          if (orgData.name) orgUpdateData.name = orgData.name;
          if (orgData.invoicing_email) orgUpdateData.invoicing_email = orgData.invoicing_email;
          if (orgData.phone) orgUpdateData.phone = orgData.phone;
          if (orgData.website_url) orgUpdateData.website_url = orgData.website_url;
          if (orgData.invoicing_address) orgUpdateData.invoicing_address = orgData.invoicing_address;
          
          // Set tenant_id if org has none and we have a valid tenant_id (from public form)
          if (tenant_id && !existingOrg.tenant_id) {
            orgUpdateData.tenant_id = tenant_id;
          }
          
          if (Object.keys(orgUpdateData).length > 0) {
            const { error: orgUpdateError } = await supabase
              .from('organization')
              .update(orgUpdateData)
              .eq('id', existingOrg.id);
            
            if (orgUpdateError) {
              console.error('[AppProcessor] Failed to update organization:', orgUpdateError);
              return res.status(500).json({ error: `Failed to update organisation: ${orgUpdateError.message}` });
            }
            console.log('[AppProcessor] Updated organization:', existingOrg.id);
          }
          createdOrganizationId = existingOrg.id;
        }
      } else {
        // Organization does not exist
        if (orgAction === 'update') {
          // Update mode but org doesn't exist - skip, but use prefill_organization_id if available
          console.log('[AppProcessor] Organization not found, skipping update (update mode)');
          createdOrganizationId = prefill_organization_id || null;
        } else if (orgAction === 'create' || orgAction === 'upsert') {
          // Create new organization - require name
          if (!orgData.name) {
            console.error('[AppProcessor] Organization creation requested but no organization.name field mapped');
            return res.status(400).json({ 
              error: 'Organisation name is required. Please map a form field to "Organisation Name" in the Submission Settings.',
              code: 'MISSING_ORG_NAME'
            });
          }
          
          const orgInsertData = {
            name: orgData.name,
            invoicing_email: orgData.invoicing_email || null,
            phone: orgData.phone || null,
            website_url: orgData.website_url || null,
            created_at: new Date().toISOString()
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            orgInsertData.tenant_id = tenant_id;
          }

          console.log('[AppProcessor] Creating organization with data:', orgInsertData);

          const { data: newOrg, error: orgError } = await supabase
            .from('organization')
            .insert(orgInsertData)
            .select()
            .single();

          if (orgError) {
            console.error('[AppProcessor] Failed to create organization:', orgError);
            return res.status(500).json({ error: `Failed to create organisation: ${orgError.message}` });
          }

          createdOrganizationId = newOrg.id;
          newlyCreatedOrgData = newOrg; // Track for workflow trigger after custom fields are saved
          console.log('[AppProcessor] Created organization:', createdOrganizationId);
        }
      }

      // Save/update org custom fields if we have an org ID
      if (createdOrganizationId && orgCustomFields.length > 0) {
        for (const cf of orgCustomFields) {
          // Upsert: check if exists, then update or insert
          const { data: existingValue } = await supabase
            .from('organization_preference_value')
            .select('id')
            .eq('organization_id', createdOrganizationId)
            .eq('field_id', cf.field_id)
            .single();
          
          if (existingValue) {
            await supabase.from('organization_preference_value')
              .update({ value: cf.value })
              .eq('id', existingValue.id);
          } else {
            await supabase.from('organization_preference_value').insert({
              organization_id: createdOrganizationId,
              field_id: cf.field_id,
              value: cf.value
            });
          }
        }
      }
      
      // Trigger workflow evaluation for newly created organization (AFTER custom fields are saved)
      // Must await to ensure completion before Vercel terminates the function
      if (newlyCreatedOrgData) {
        const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
        console.log('[AppProcessor] Triggering workflows for organization:', newlyCreatedOrgData.id, 'tenant_id:', newlyCreatedOrgData.tenant_id);
        try {
          await triggerWorkflows('organization', newlyCreatedOrgData.id, null, newlyCreatedOrgData, 'record_create', baseUrl);
          console.log('[AppProcessor] Workflow evaluation completed for organization:', newlyCreatedOrgData.id);
        } catch (err) {
          console.error('[AppProcessor] Workflow error for organization:', err);
        }
      }
    }

    // Process member based on memberAction (none/create/update/upsert)
    if (shouldProcessMember) {
      console.log('[AppProcessor] Member processing enabled. Action:', memberAction, 'MemberData:', memberData, 'PrefillMemberId:', prefill_member_id);
      
      // Find existing member: by prefill_member_id first, then by email
      let existingMember = null;
      
      if (prefill_member_id) {
        const { data: foundMember } = await supabase
          .from('member')
          .select('*')
          .eq('id', prefill_member_id)
          .single();
        existingMember = foundMember;
        console.log('[AppProcessor] Found member by prefill ID:', existingMember?.id);
      } else if (memberData.email) {
        const { data: foundMember } = await supabase
          .from('member')
          .select('*')
          .ilike('email', memberData.email)
          .limit(1)
          .single();
        existingMember = foundMember;
        console.log('[AppProcessor] Found member by email:', existingMember?.id);
      }
      
      if (existingMember) {
        // Member exists
        if (memberAction === 'create') {
          // Create mode but member exists - skip creation, use existing ID
          console.log('[AppProcessor] Member exists, skipping create (create mode):', existingMember.id);
          createdMemberId = existingMember.id;
        } else if (memberAction === 'update' || memberAction === 'upsert') {
          // Update existing member
          // Note: member table doesn't have phone column
          const memberUpdateData = {};
          if (memberData.email) memberUpdateData.email = memberData.email;
          if (memberData.first_name) memberUpdateData.first_name = memberData.first_name;
          if (memberData.last_name) memberUpdateData.last_name = memberData.last_name;
          if (memberData.job_title) memberUpdateData.job_title = memberData.job_title;
          if (memberData.mobile) memberUpdateData.mobile = memberData.mobile;
          if (memberData.landline) memberUpdateData.landline = memberData.landline;
          
          // Determine effective role_id from multiple sources
          const effectiveRoleIdForUpdate = memberData.role_id !== undefined ? memberData.role_id : role_id;
          console.log('[AppProcessor] Role ID resolution (update):', { 
            memberData_role_id: memberData.role_id, 
            role_id_param: role_id, 
            effectiveRoleIdForUpdate 
          });
          
          // Check capacity when:
          // 1. Role is being changed (different role_id)
          // 2. Organization is being changed AND member has/will have a role with max_members
          const targetOrgId = createdOrganizationId || memberData.organization_id || prefill_organization_id || existingMember.organization_id;
          const roleToCheckCapacity = effectiveRoleIdForUpdate !== undefined ? effectiveRoleIdForUpdate : existingMember.role_id;
          
          const roleIsChanging = effectiveRoleIdForUpdate !== undefined && 
            effectiveRoleIdForUpdate !== null && 
            effectiveRoleIdForUpdate !== existingMember.role_id;
          const orgIsChanging = targetOrgId && existingMember.organization_id && 
            targetOrgId !== existingMember.organization_id;
          
          // Check capacity if role or org is changing (and member has/will have a role)
          if (roleToCheckCapacity && roleToCheckCapacity !== null && (roleIsChanging || orgIsChanging)) {
            console.log('[AppProcessor] Checking capacity for primary member update:', { 
              roleIsChanging,
              orgIsChanging,
              from: { role: existingMember.role_id, org: existingMember.organization_id },
              to: { role: roleToCheckCapacity, org: targetOrgId }
            });
            const capacityCheck = await checkRoleCapacity(supabase, roleToCheckCapacity, targetOrgId);
            console.log('[AppProcessor] Role capacity check result (update):', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                return res.status(400).json({ 
                  error: `Cannot assign this role without an organization.`,
                  code: 'ROLE_CAPACITY_MISSING_ORG'
                });
              }
              return res.status(400).json({ 
                error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                code: 'ROLE_CAPACITY_EXCEEDED'
              });
            }
          }
          
          if (effectiveRoleIdForUpdate !== undefined) {
            memberUpdateData.role_id = effectiveRoleIdForUpdate;
          }
          
          // Add login_enabled from pipeline config if specified
          if (memberData.login_enabled !== undefined) {
            memberUpdateData.login_enabled = memberData.login_enabled;
            console.log('[AppProcessor] Adding pipeline login_enabled to member update:', memberData.login_enabled);
          }
          
          // Add show_in_directory from pipeline config if specified
          if (memberData.show_in_directory !== undefined) {
            memberUpdateData.show_in_directory = memberData.show_in_directory;
            console.log('[AppProcessor] Adding pipeline show_in_directory to member update:', memberData.show_in_directory);
          }
          
          // Handle full_name parsing if provided (parse into first_name/last_name since member table doesn't have full_name column)
          if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
            const nameParts = memberData.full_name.trim().split(/\s+/);
            memberUpdateData.first_name = nameParts[0] || '';
            memberUpdateData.last_name = nameParts.slice(1).join(' ') || '';
          }
          
          // Use createdOrganizationId if org was created/updated, otherwise use prefill_organization_id
          const orgIdToLink = createdOrganizationId || prefill_organization_id;
          if (orgIdToLink) memberUpdateData.organization_id = orgIdToLink;
          
          if (Object.keys(memberUpdateData).length > 0) {
            const { error: memberUpdateError } = await supabase
              .from('member')
              .update(memberUpdateData)
              .eq('id', existingMember.id);
            
            if (memberUpdateError) {
              console.error('[AppProcessor] Failed to update member:', memberUpdateError);
              return res.status(500).json({ error: `Failed to update member: ${memberUpdateError.message}` });
            }
            console.log('[AppProcessor] Updated member:', existingMember.id);
          }
          createdMemberId = existingMember.id;
        }
      } else {
        // Member does not exist
        if (memberAction === 'update') {
          // Update mode but member doesn't exist - skip
          console.log('[AppProcessor] Member not found, skipping update (update mode)');
        } else if (memberAction === 'create' || memberAction === 'upsert') {
          // Create new member - require email
          if (!memberData.email) {
            console.error('[AppProcessor] Member creation requested but no member.email field mapped');
            return res.status(400).json({ 
              error: 'Member email is required. Please map a form field to "Email" (target: member.email) in the Submission Settings.',
              code: 'MISSING_MEMBER_EMAIL'
            });
          }
          
          if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
            const nameParts = memberData.full_name.trim().split(/\s+/);
            memberData.first_name = nameParts[0] || '';
            memberData.last_name = nameParts.slice(1).join(' ') || '';
          }
          
          // Use createdOrganizationId if org was created/updated, 
          // then memberData.organization_id (from form dropdown), then prefill_organization_id
          const orgIdForNewMember = createdOrganizationId || memberData.organization_id || prefill_organization_id || null;
          console.log('[AppProcessor] Resolved orgIdForNewMember:', orgIdForNewMember);

          // Note: member table doesn't have phone or status columns
          const memberInsertData = {
            email: memberData.email,
            first_name: memberData.first_name || '',
            last_name: memberData.last_name || '',
            organization_id: orgIdForNewMember,
            login_enabled: memberData.login_enabled !== undefined ? memberData.login_enabled : true,
            show_in_directory: memberData.show_in_directory !== undefined ? memberData.show_in_directory : true
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            memberInsertData.tenant_id = tenant_id;
          }
          
          // Add job_title only if provided (it's a valid column)
          if (memberData.job_title) memberInsertData.job_title = memberData.job_title;
          // Add mobile and landline if provided
          if (memberData.mobile) memberInsertData.mobile = memberData.mobile;
          if (memberData.landline) memberInsertData.landline = memberData.landline;
          
          // Determine effective role_id from multiple sources:
          // 1. Pipeline config role_id (memberData.role_id)
          // 2. Form conditional logic role_id (role_id param)
          const effectiveRoleId = memberData.role_id !== undefined ? memberData.role_id : role_id;
          console.log('[AppProcessor] Role ID resolution:', { 
            memberData_role_id: memberData.role_id, 
            role_id_param: role_id, 
            effectiveRoleId 
          });
          
          // Add role_id if we have one from any source
          if (effectiveRoleId !== undefined) {
            memberInsertData.role_id = effectiveRoleId;
            console.log('[AppProcessor] Adding role_id to member insert:', effectiveRoleId);
            
            // Check role capacity before inserting member (per-organization)
            if (effectiveRoleId !== null) {
              const capacityCheck = await checkRoleCapacity(supabase, effectiveRoleId, orgIdForNewMember);
              console.log('[AppProcessor] Role capacity check result:', JSON.stringify(capacityCheck));
              if (!capacityCheck.hasCapacity) {
                if (capacityCheck.missingOrgContext) {
                  console.error('[AppProcessor] Cannot check capacity: organization context required');
                  return res.status(400).json({ 
                    error: `Cannot assign this role without an organization.`,
                    code: 'ROLE_CAPACITY_MISSING_ORG'
                  });
                }
                console.error('[AppProcessor] Role at max capacity:', capacityCheck.currentCount, '/', capacityCheck.maxMembers);
                return res.status(400).json({ 
                  error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                  code: 'ROLE_CAPACITY_EXCEEDED'
                });
              }
            }
          } else {
            console.log('[AppProcessor] No role_id from any source');
          }
          
          console.log('[AppProcessor] login_enabled for member insert:', memberInsertData.login_enabled);

          console.log('[AppProcessor] Final memberInsertData:', JSON.stringify(memberInsertData));

          const { data: newMember, error: memberError } = await supabase
            .from('member')
            .insert(memberInsertData)
            .select()
            .single();

          if (memberError) {
            console.error('[AppProcessor] Failed to create member:', memberError);
            return res.status(500).json({ error: `Failed to create member: ${memberError.message}` });
          }

          createdMemberId = newMember.id;
          console.log('[AppProcessor] Created member:', createdMemberId);
          
          // Trigger workflows for new member creation
          // Must await to ensure completion before Vercel terminates the function
          const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
          try {
            await triggerWorkflows('member', createdMemberId, null, newMember, 'record_create', baseUrl);
            console.log('[AppProcessor] Workflow evaluation completed for member:', createdMemberId);
          } catch (err) {
            console.error('[AppProcessor] Workflow error:', err);
          }
          console.log('[AppProcessor] Triggered workflows for new member:', createdMemberId);
        }
      }

      // Save/update member custom fields
      for (const cf of memberCustomFields) {
        // Upsert: check if exists, then update or insert
        const { data: existingValue } = await supabase
          .from('member_preference_value')
          .select('id')
          .eq('member_id', createdMemberId)
          .eq('field_id', cf.field_id)
          .single();
        
        if (existingValue) {
          await supabase.from('member_preference_value')
            .update({ value: cf.value })
            .eq('id', existingValue.id);
        } else {
          await supabase.from('member_preference_value').insert({
            member_id: createdMemberId,
            field_id: cf.field_id,
            value: cf.value
          });
        }
      }

      // Handle category_multiselect field values - save to member_resource_category table
      // Uses diff-based approach: only add/remove what changed
      const categoryFields = fields.filter(f => f.type === 'category_multiselect' || f.type === 'resource_categories');
      if (createdMemberId && categoryFields.length > 0) {
        // Get all resource categories to map subcategory names to category IDs
        const { data: resourceCategories } = await supabase
          .from('resource_category')
          .select('id, name, subcategories')
          .eq('is_active', true);
        
        // Parse subcategories that might be stored as JSON strings and normalize
        const categoryMap = new Map((resourceCategories || []).map(c => {
          let subcats = c.subcategories || [];
          // Handle case where subcategories is stored as JSON string
          if (typeof subcats === 'string') {
            try {
              subcats = JSON.parse(subcats);
            } catch {
              subcats = [];
            }
          }
          // Ensure it's an array and trim all values
          if (!Array.isArray(subcats)) subcats = [];
          subcats = subcats.map(s => String(s).trim()).filter(Boolean);
          return [c.id, subcats];
        }));
        
        // Build set of category IDs affected by the form fields
        const formCategoryIds = new Set();
        for (const field of categoryFields) {
          const allowedCatIds = field.allowed_category_ids?.length > 0 
            ? field.allowed_category_ids 
            : Array.from(categoryMap.keys());
          allowedCatIds.forEach(id => formCategoryIds.add(id));
        }
        
        // Build list of category selections from all category_multiselect fields
        const categorySelections = [];
        
        for (const field of categoryFields) {
          const selectedValues = form_values[field.id];
          if (!Array.isArray(selectedValues) || selectedValues.length === 0) continue;
          
          // Get allowed categories for this field (or all if not specified)
          const allowedCategoryIds = field.allowed_category_ids?.length > 0 
            ? field.allowed_category_ids 
            : Array.from(categoryMap.keys());
          
          // Map selected subcategory names to their parent category IDs
          for (const subcatName of selectedValues) {
            const normalizedSubcat = String(subcatName).trim();
            // Find which category this subcategory belongs to
            for (const catId of allowedCategoryIds) {
              const subcats = categoryMap.get(catId);
              if (subcats && subcats.includes(normalizedSubcat)) {
                categorySelections.push({
                  category_id: catId,
                  subcategory_name: normalizedSubcat
                });
                break;
              }
            }
          }
        }
        
        // Get current selections for diff-based update (always do this, even for empty submissions)
        const { data: currentSelections } = await supabase
          .from('member_resource_category')
          .select('id, resource_category_id, subcategory_name')
          .eq('member_id', createdMemberId);
        
        const existing = currentSelections || [];
        const currentKeys = new Set(
          existing.map(s => `${s.resource_category_id}|${s.subcategory_name || ''}`)
        );
        const newKeys = new Set(
          categorySelections.map(s => `${s.category_id}|${s.subcategory_name || ''}`)
        );
        
        // Find selections to add
        const toAdd = categorySelections.filter(s => 
          !currentKeys.has(`${s.category_id}|${s.subcategory_name || ''}`)
        );
        
        // Find selections to remove (only remove if in the same categories as the form fields)
        const toRemove = existing.filter(s => 
          formCategoryIds.has(s.resource_category_id) && 
          !newKeys.has(`${s.resource_category_id}|${s.subcategory_name || ''}`)
        );
        
        // Remove old selections (including when form submits empty to clear selections)
        if (toRemove.length > 0) {
          const removeIds = toRemove.map(s => s.id);
          await supabase
            .from('member_resource_category')
            .delete()
            .in('id', removeIds);
          console.log(`[AppProcessor] Removed ${toRemove.length} category selections`);
        }
        
        // Add new selections
        if (toAdd.length > 0) {
          const insertData = toAdd.map(sel => ({
            member_id: createdMemberId,
            resource_category_id: sel.category_id,
            subcategory_name: sel.subcategory_name
          }));
          
          await supabase
            .from('member_resource_category')
            .insert(insertData);
          console.log(`[AppProcessor] Added ${toAdd.length} category selections`);
        }
      }
    }
    
    // Handle communication_preferences field values - save to member_communication_preference table
    // Only update categories that are explicitly included in the form submission
    // Do NOT auto-subscribe missing categories - this preserves existing opt-outs
    if (createdMemberId && fields) {
      const commPrefFields = fields.filter(f => f.type === 'communication_preferences');
      if (commPrefFields.length > 0) {
        console.log(`[AppProcessor] Processing ${commPrefFields.length} communication preference fields`);
        
        // Collect communication preference selections from form values
        // Only include categories that were explicitly submitted
        const commPrefSelections = [];
        const processedCategoryIds = new Set();
        
        for (const field of commPrefFields) {
          const prefValues = form_values[field.id];
          if (prefValues && typeof prefValues === 'object') {
            // prefValues is an object: { categoryId: boolean }
            for (const [categoryId, isSubscribed] of Object.entries(prefValues)) {
              if (!processedCategoryIds.has(categoryId)) {
                commPrefSelections.push({
                  category_id: categoryId,
                  is_subscribed: Boolean(isSubscribed)
                });
                processedCategoryIds.add(categoryId);
              }
            }
          }
        }
        
        // Note: We intentionally do NOT add missing categories with default values
        // This preserves existing preferences for categories not included in this form
        
        if (commPrefSelections.length > 0) {
          console.log(`[AppProcessor] Saving ${commPrefSelections.length} communication preferences for member:`, createdMemberId);
          
          // Upsert each communication preference
          for (const pref of commPrefSelections) {
            // Check if preference already exists
            const { data: existingPref } = await supabase
              .from('member_communication_preference')
              .select('id')
              .eq('member_id', createdMemberId)
              .eq('category_id', pref.category_id)
              .single();
            
            if (existingPref) {
              // Update existing preference
              await supabase
                .from('member_communication_preference')
                .update({ is_subscribed: pref.is_subscribed })
                .eq('id', existingPref.id);
            } else {
              // Insert new preference
              await supabase
                .from('member_communication_preference')
                .insert({
                  member_id: createdMemberId,
                  category_id: pref.category_id,
                  is_subscribed: pref.is_subscribed
                });
            }
          }
          console.log(`[AppProcessor] Saved communication preferences for member:`, createdMemberId);
        }
      }
    }

    // Save communication preferences (marketing list subscriptions) for primary member
    if (createdMemberId && memberCommunicationPrefsMap.size > 0) {
      console.log(`[AppProcessor] Saving ${memberCommunicationPrefsMap.size} communication preferences for member ${createdMemberId}`);
      
      for (const [categoryId, isSubscribed] of memberCommunicationPrefsMap) {
        // Check if preference already exists
        const { data: existingPref } = await supabase
          .from('member_communication_preference')
          .select('id, is_subscribed')
          .eq('member_id', createdMemberId)
          .eq('category_id', categoryId)
          .single();
        
        if (existingPref) {
          // Update existing preference only if different
          if (existingPref.is_subscribed !== isSubscribed) {
            await supabase
              .from('member_communication_preference')
              .update({ is_subscribed: isSubscribed, updated_at: new Date().toISOString() })
              .eq('id', existingPref.id);
            console.log(`[AppProcessor] Updated communication preference: category=${categoryId}, subscribed=${isSubscribed}`);
          } else {
            console.log(`[AppProcessor] Communication preference unchanged: category=${categoryId}, subscribed=${isSubscribed}`);
          }
        } else {
          // Create new preference
          await supabase
            .from('member_communication_preference')
            .insert({
              member_id: createdMemberId,
              category_id: categoryId,
              is_subscribed: isSubscribed
            });
          console.log(`[AppProcessor] Created communication preference: category=${categoryId}, subscribed=${isSubscribed}`);
        }
      }
    }

    // Process member pipelines (additional members) with sequential upsert logic
    // Use entity_pipelines.members if available, fall back to legacy additional_member_creations
    // Track processed emails to handle same email appearing in multiple member configs
    // Store full context: {id, role_id, organization_id} to ensure capacity checks use latest data
    const processedEmails = new Map(); // email -> {id, role_id, organization_id}
    
    // If primary member was created/updated, track its email with full context
    // Fetch current state from DB to ensure we have authoritative role_id/organization_id after mutations
    if (createdMemberId) {
      const { data: primaryMemberState } = await supabase
        .from('member')
        .select('id, email, role_id, organization_id')
        .eq('id', createdMemberId)
        .single();
      
      if (primaryMemberState?.email) {
        const primaryEmail = primaryMemberState.email.toLowerCase();
        processedEmails.set(primaryEmail, { 
          id: primaryMemberState.id, 
          role_id: primaryMemberState.role_id, 
          organization_id: primaryMemberState.organization_id 
        });
        console.log('[AppProcessor] Tracking primary member email (from DB):', primaryEmail, '->', { 
          id: primaryMemberState.id, 
          role_id: primaryMemberState.role_id, 
          organization_id: primaryMemberState.organization_id 
        });
      }
    }
    
    // Merge member pipelines: use entity_pipelines.members if available, otherwise legacy additional_member_creations
    // Filter out primary member from pipelines (it was already processed above via field_mappings)
    let memberCreationConfigs = [];
    if (memberPipelines.length > 0) {
      // New system: use entity_pipelines.members, skip primary (it's handled by existing field_mappings logic)
      memberCreationConfigs = memberPipelines.filter(m => !m.isPrimary);
      console.log('[AppProcessor] Using entity_pipelines.members:', memberCreationConfigs.length, 'non-primary entries');
    } else if (additional_member_creations && Array.isArray(additional_member_creations) && additional_member_creations.length > 0) {
      // Legacy system: use additional_member_creations
      memberCreationConfigs = additional_member_creations;
      console.log('[AppProcessor] Using legacy additional_member_creations:', memberCreationConfigs.length);
    }
    
    const additionalMemberIds = [];
    if (memberCreationConfigs.length > 0) {
      console.log('[AppProcessor] Processing member creations:', memberCreationConfigs.length);
      
      // Pre-fetch system settings for welcome emails (only once)
      const { data: allSettings } = await supabase
        .from('system_settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['app_name', 'welcome_email_from_address', 'welcome_email_from_name']);
      
      const settingsMap = {};
      (allSettings || []).forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
      
      const appName = settingsMap['app_name'] || 'ICONN';
      const loginUrl = process.env.APP_URL || 'https://iconn.app';
      const fromAddress = settingsMap['welcome_email_from_address'] || process.env.MAILGUN_FROM_EMAIL || 'noreply@mail.iconn.app';
      const fromName = settingsMap['welcome_email_from_name'] || appName;
      
      for (let configIndex = 0; configIndex < memberCreationConfigs.length; configIndex++) {
        const memberConfig = memberCreationConfigs[configIndex];
        console.log(`[AppProcessor] ======= Processing member config ${configIndex + 1}/${memberCreationConfigs.length}: "${memberConfig.label}" =======`);
        console.log('[AppProcessor] Config mappings:', JSON.stringify(memberConfig.mappings, null, 2));
        
        // Log actual form_values for each source_field_id to debug value issues
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          console.log('[AppProcessor] Form values for this member config:');
          for (const m of memberConfig.mappings) {
            if (m.source_field_id) {
              console.log(`  - ${m.target_field}: form_values["${m.source_field_id}"] = "${form_values[m.source_field_id]}"`);
            }
          }
        }
        
        // Extract email and build data from either new mappings array or legacy field_mappings object
        let memberEmail = null;
        const additionalMemberData = {};
        const additionalCustomFieldsMap = new Map();
        const clearFields = [];
        
        const coreFieldMappings = {
          'email': 'email',
          'first_name': 'first_name',
          'last_name': 'last_name',
          'phone': 'mobile',
          'job_title': 'job_title',
          'mobile': 'mobile',
          'landline': 'landline',
          'organization_id': 'organization_id',
          'show_in_directory': 'show_in_directory'
        };
        
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          // New format: process mappings array
          const emailMapping = memberConfig.mappings.find(m => m.target_field === 'email' && m.target_type === 'core');
          if (!emailMapping) {
            console.log('[AppProcessor] Skipping additional member - no email mapping:', memberConfig.label);
            continue;
          }
          
          // Get email value
          if (emailMapping.source_type === 'static') {
            memberEmail = emailMapping.static_value;
          } else if (emailMapping.source_field_id) {
            memberEmail = form_values[emailMapping.source_field_id];
          }
          
          if (!memberEmail) {
            console.log('[AppProcessor] Skipping additional member - email value is empty:', memberConfig.label);
            continue;
          }
          
          // Process all mappings
          for (const mapping of memberConfig.mappings) {
            if (!mapping.target_field || mapping.target_field === 'email') continue;
            
            let value;
            if (mapping.source_type === 'static') {
              value = mapping.static_value;
            } else if (mapping.transformation === 'current_date') {
              value = new Date().toISOString().split('T')[0];
            } else if (mapping.source_field_id) {
              value = form_values[mapping.source_field_id];
            }
            
            // Handle __clear__ sentinel value
            if (value === '__clear__') {
              if (mapping.target_type === 'core') {
                const dbKey = coreFieldMappings[mapping.target_field] || mapping.target_field;
                clearFields.push(dbKey);
                additionalMemberData[dbKey] = null;
              } else if (mapping.target_type === 'custom') {
                // Mark custom field for clearing - will be handled in custom field processing
                additionalCustomFieldsMap.set(mapping.target_field, '__clear__');
              }
              continue;
            }
            
            if (value !== undefined && value !== null && mapping.transformation && mapping.transformation !== 'none') {
              value = applyTransformation(value, mapping.transformation);
            }
            
            if (mapping.target_type === 'core') {
              const dbKey = coreFieldMappings[mapping.target_field] || mapping.target_field;
              // Use hasAssignableValue to allow boolean false/empty through for boolean fields
              if (hasAssignableValue(dbKey, value)) {
                // Coerce boolean fields for member entities
                additionalMemberData[dbKey] = coerceBooleanField(dbKey, value);
              }
            } else if (mapping.target_type === 'custom') {
              const prefField = prefFieldMap.get(mapping.target_field);
              if (value !== undefined && value !== null && value !== '') {
                addCustomFieldValue(additionalCustomFieldsMap, mapping.target_field, value, prefField);
              }
            }
          }
        } else if (memberConfig.field_mappings) {
          // Legacy format: process field_mappings object
          if (!memberConfig.field_mappings.email) {
            console.log('[AppProcessor] Skipping additional member - no email mapping:', memberConfig.label);
            continue;
          }
          
          const emailFieldId = memberConfig.field_mappings.email;
          if (emailFieldId === '__clear__') {
            console.log('[AppProcessor] Skipping additional member - email set to clear:', memberConfig.label);
            continue;
          }
          
          memberEmail = form_values[emailFieldId];
          
          if (!memberEmail) {
            console.log('[AppProcessor] Skipping additional member - email value is empty:', memberConfig.label);
            continue;
          }
          
          for (const [configKey, dbKey] of Object.entries(coreFieldMappings)) {
            if (configKey === 'email') continue;
            const fieldId = memberConfig.field_mappings[configKey];
            if (!fieldId) continue;
            
            if (fieldId === '__clear__') {
              clearFields.push(dbKey);
              additionalMemberData[dbKey] = null;
            } else if (hasAssignableValue(dbKey, form_values[fieldId])) {
              // Coerce boolean fields for member entities
              additionalMemberData[dbKey] = coerceBooleanField(dbKey, form_values[fieldId]);
            }
          }
        } else {
          console.log('[AppProcessor] Skipping additional member - no mappings:', memberConfig.label);
          continue;
        }
        
        const normalizedEmail = memberEmail.toLowerCase().trim();
        
        console.log(`[AppProcessor] Built data for "${memberConfig.label}":`, {
          email: normalizedEmail,
          additionalMemberData: { ...additionalMemberData },
          customFieldCount: additionalCustomFieldsMap.size
        });
        
        // Add role_id if specified in this member config
        if (memberConfig.role_id) {
          if (memberConfig.role_id === '__clear__') {
            additionalMemberData.role_id = null;
            clearFields.push('role_id');
          } else {
            additionalMemberData.role_id = memberConfig.role_id;
          }
          console.log('[AppProcessor] Additional member role_id:', additionalMemberData.role_id);
        }
        
        // Add login_enabled from member config if specified
        if (memberConfig.login_enabled !== undefined) {
          additionalMemberData.login_enabled = memberConfig.login_enabled;
          console.log('[AppProcessor] Additional member login_enabled:', memberConfig.login_enabled);
        }
        
        console.log('[AppProcessor] Processing additional member:', memberConfig.label, 'email:', normalizedEmail, 'data:', additionalMemberData, 'clearFields:', clearFields);
        
        // Check if we've already processed this email in this submission
        // processedEmails stores {id, role_id, organization_id} for in-memory context
        const processedEntry = processedEmails.get(normalizedEmail);
        let existingMemberId = processedEntry?.id || null;
        let isNewMember = false;
        
        // Use in-memory context if available, otherwise fetch from DB
        let existingMemberRecord = processedEntry ? { 
          id: processedEntry.id, 
          role_id: processedEntry.role_id, 
          organization_id: processedEntry.organization_id 
        } : null;
        
        if (!existingMemberId) {
          // Check if member exists in database
          const { data: existingMember } = await supabase
            .from('member')
            .select('id, role_id, organization_id')
            .ilike('email', normalizedEmail)
            .limit(1)
            .single();
          
          if (existingMember) {
            existingMemberId = existingMember.id;
            existingMemberRecord = existingMember;
            console.log('[AppProcessor] Found existing member in DB:', normalizedEmail, '->', existingMemberId);
          }
        } else {
          console.log('[AppProcessor] Using in-memory context for:', normalizedEmail, existingMemberRecord);
        }
        
        if (existingMemberId) {
          // UPDATE existing member - merge fields, don't clear unless explicitly requested
          console.log('[AppProcessor] Updating existing member:', existingMemberId, 'with:', additionalMemberData);
          
          // Check role capacity when:
          // 1. Role is being changed (different role_id)
          // 2. Organization is being changed (member moving to new org) AND member has a role with max_members
          // This ensures per-org capacity is enforced both for role changes and org moves
          const effectiveRoleToCheck = additionalMemberData.role_id !== undefined 
            ? additionalMemberData.role_id 
            : existingMemberRecord?.role_id;
          const targetOrgId = createdOrganizationId || additionalMemberData.organization_id || prefill_organization_id || existingMemberRecord?.organization_id;
          
          const roleIsChanging = additionalMemberData.role_id && additionalMemberData.role_id !== null && 
            (!existingMemberRecord || additionalMemberData.role_id !== existingMemberRecord.role_id);
          const orgIsChanging = targetOrgId && existingMemberRecord?.organization_id && 
            targetOrgId !== existingMemberRecord.organization_id;
          
          // Check capacity if role or org is changing (and member has/will have a role)
          if (effectiveRoleToCheck && effectiveRoleToCheck !== null && (roleIsChanging || orgIsChanging)) {
            console.log('[AppProcessor] Checking capacity for additional member update:', {
              roleIsChanging,
              orgIsChanging,
              from: { role: existingMemberRecord?.role_id, org: existingMemberRecord?.organization_id },
              to: { role: effectiveRoleToCheck, org: targetOrgId }
            });
            const capacityCheck = await checkRoleCapacity(supabase, effectiveRoleToCheck, targetOrgId);
            console.log('[AppProcessor] Additional member update capacity check:', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                return res.status(400).json({ 
                  error: `Cannot assign this role without an organization.`,
                  code: 'ROLE_CAPACITY_MISSING_ORG'
                });
              }
              return res.status(400).json({ 
                error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                code: 'ROLE_CAPACITY_EXCEEDED'
              });
            }
          }
          
          let trackingUpdated = false;
          if (Object.keys(additionalMemberData).length > 0) {
            const { data: updatedMember, error: updateError } = await supabase
              .from('member')
              .update(additionalMemberData)
              .eq('id', existingMemberId)
              .select('id, role_id, organization_id')
              .single();
            
            if (updateError) {
              console.error('[AppProcessor] Failed to update additional member:', updateError);
            } else {
              console.log('[AppProcessor] Updated member:', existingMemberId);
              // Update in-memory context with authoritative values from DB after mutation
              if (updatedMember) {
                processedEmails.set(normalizedEmail, { 
                  id: updatedMember.id, 
                  role_id: updatedMember.role_id, 
                  organization_id: updatedMember.organization_id 
                });
                trackingUpdated = true;
                console.log('[AppProcessor] Updated tracking (from DB):', { 
                  role_id: updatedMember.role_id, 
                  organization_id: updatedMember.organization_id 
                });
              }
            }
          }
          
          // Always ensure processedEmails has authoritative data - fetch from DB if not already updated
          // This handles cases where no mutations occurred but we still need accurate tracking
          if (!trackingUpdated) {
            const { data: currentMemberState } = await supabase
              .from('member')
              .select('id, role_id, organization_id')
              .eq('id', existingMemberId)
              .single();
            
            if (currentMemberState) {
              processedEmails.set(normalizedEmail, { 
                id: currentMemberState.id, 
                role_id: currentMemberState.role_id, 
                organization_id: currentMemberState.organization_id 
              });
              console.log('[AppProcessor] Refreshed tracking (no mutation):', { 
                role_id: currentMemberState.role_id, 
                organization_id: currentMemberState.organization_id 
              });
            }
          }
          
          additionalMemberIds.push({ id: existingMemberId, label: memberConfig.label, created: false, updated: true });
        } else {
          // CREATE new member
          isNewMember = true;
          const additionalOrgId = createdOrganizationId || additionalMemberData.organization_id || prefill_organization_id || null;
          const newMemberData = {
            email: memberEmail,
            login_enabled: additionalMemberData.login_enabled !== undefined ? additionalMemberData.login_enabled : true,
            show_in_directory: additionalMemberData.show_in_directory !== undefined ? additionalMemberData.show_in_directory : true,
            organization_id: additionalOrgId,
            ...additionalMemberData
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            newMemberData.tenant_id = tenant_id;
          }
          
          // Check role capacity before creating additional member (per-organization)
          if (newMemberData.role_id && newMemberData.role_id !== null) {
            const capacityCheck = await checkRoleCapacity(supabase, newMemberData.role_id, additionalOrgId);
            console.log('[AppProcessor] Additional member role capacity check:', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                console.error('[AppProcessor] Additional member: cannot assign role without org');
                return res.status(400).json({ 
                  error: `Cannot assign this role without an organization.`,
                  code: 'ROLE_CAPACITY_MISSING_ORG'
                });
              }
              console.error('[AppProcessor] Additional member: role at max capacity');
              return res.status(400).json({ 
                error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                code: 'ROLE_CAPACITY_EXCEEDED'
              });
            }
          }
          
          console.log('[AppProcessor] Creating new additional member:', memberConfig.label, newMemberData);
          
          const { data: newMember, error: memberError } = await supabase
            .from('member')
            .insert(newMemberData)
            .select()
            .single();
          
          if (memberError) {
            console.error('[AppProcessor] Failed to create additional member:', memberError);
            continue;
          }
          
          existingMemberId = newMember.id;
          additionalMemberIds.push({ id: newMember.id, label: memberConfig.label, created: true, updated: false });
          // Track with full context from the actual created record (not the input data)
          // This ensures subsequent entries get authoritative role_id/organization_id
          processedEmails.set(normalizedEmail, { 
            id: newMember.id, 
            role_id: newMember.role_id || null, 
            organization_id: newMember.organization_id 
          });
          console.log('[AppProcessor] Created additional member:', newMember.id, 'tracking:', { role_id: newMember.role_id, organization_id: newMember.organization_id });
          
          // Trigger workflows for new additional member creation
          // Must await to ensure completion before Vercel terminates the function
          const addlBaseUrl = process.env.APP_URL || `https://${req.headers.host}`;
          try {
            await triggerWorkflows('member', newMember.id, null, newMember, 'record_create', addlBaseUrl);
            console.log('[AppProcessor] Workflow evaluation completed for additional member:', newMember.id);
          } catch (err) {
            console.error('[AppProcessor] Additional member workflow error:', err);
          }
        }
        
        // Process custom field mappings (upsert logic)
        // For new format, custom fields were already collected in additionalCustomFieldsMap
        // For legacy format, process from field_mappings object
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          // New format: custom fields already in additionalCustomFieldsMap
          for (const [customFieldId, value] of additionalCustomFieldsMap.entries()) {
            if (value === '__clear__') {
              // Clear this custom field
              await supabase
                .from('member_preference_value')
                .delete()
                .eq('member_id', existingMemberId)
                .eq('field_id', customFieldId);
              console.log('[AppProcessor] Cleared custom field:', customFieldId, 'for additional member:', existingMemberId);
            } else if (value !== undefined && value !== null && value !== '') {
              const { data: existingPref } = await supabase
                .from('member_preference_value')
                .select('id')
                .eq('member_id', existingMemberId)
                .eq('field_id', customFieldId)
                .single();
              
              const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
              
              if (existingPref) {
                await supabase
                  .from('member_preference_value')
                  .update({ value: storedValue })
                  .eq('id', existingPref.id);
              } else {
                await supabase
                  .from('member_preference_value')
                  .insert({
                    member_id: existingMemberId,
                    field_id: customFieldId,
                    value: storedValue
                  });
              }
            }
          }
        } else if (memberConfig.field_mappings) {
          // Legacy format: process custom fields from field_mappings object
          const customFieldMappings = Object.entries(memberConfig.field_mappings)
            .filter(([key]) => key.startsWith('custom_'));
          
          if (customFieldMappings.length > 0) {
            for (const [key, fieldId] of customFieldMappings) {
              if (!fieldId) continue;
              
              const customFieldId = key.replace('custom_', '');
              
              if (fieldId === '__clear__') {
                await supabase
                  .from('member_preference_value')
                  .delete()
                  .eq('member_id', existingMemberId)
                  .eq('field_id', customFieldId);
                console.log('[AppProcessor] Cleared custom field:', customFieldId, 'for member:', existingMemberId);
              } else if (form_values[fieldId] !== undefined && form_values[fieldId] !== null && form_values[fieldId] !== '') {
                const value = form_values[fieldId];
                
                const { data: existingPref } = await supabase
                  .from('member_preference_value')
                  .select('id')
                  .eq('member_id', existingMemberId)
                  .eq('field_id', customFieldId)
                  .single();
                
                if (existingPref) {
                  await supabase
                    .from('member_preference_value')
                    .update({ value: String(value) })
                    .eq('id', existingPref.id);
                } else {
                  await supabase
                    .from('member_preference_value')
                    .insert({
                      member_id: existingMemberId,
                      field_id: customFieldId,
                      value: String(value)
                    });
                }
              }
            }
          }
        }
        
        // Generate temporary password and send welcome email only for NEW members
        if (isNewMember) {
          try {
            // Check if credentials already exist
            const { data: existingCreds } = await supabase
              .from('member_credentials')
              .select('id')
              .eq('member_id', existingMemberId)
              .single();
            
            if (!existingCreds) {
              const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
              let tempPassword = '';
              for (let i = 0; i < 12; i++) {
                tempPassword += chars.charAt(Math.floor(Math.random() * chars.length));
              }
              
              const passwordHash = await bcrypt.hash(tempPassword, 12);
              
              const { error: credError } = await supabase
                .from('member_credentials')
                .insert({
                  member_id: existingMemberId,
                  email: normalizedEmail,
                  password_hash: passwordHash,
                  is_temp_password: true,
                  password_set_at: new Date().toISOString()
                });
              
              if (!credError) {
                const emailHtml = `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>Welcome to ${appName}!</h2>
                    <p>Your account has been created. Here are your login details:</p>
                    <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                      <p><strong>Email:</strong> ${memberEmail}</p>
                      <p><strong>Temporary Password:</strong> <code style="background-color: #e0e0e0; padding: 4px 8px; border-radius: 4px;">${tempPassword}</code></p>
                    </div>
                    <p>Please log in and change your password as soon as possible.</p>
                    <p style="margin-top: 20px;">
                      <a href="${loginUrl}/login" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                        Log In Now
                      </a>
                    </p>
                  </div>
                `;
                
                await sendEmail({
                  to: memberEmail,
                  subject: `Welcome to ${appName} - Your Login Details`,
                  html: emailHtml,
                  from: `${fromName} <${fromAddress}>`,
                  tenantId: tenant_id
                });
                
                console.log('[AppProcessor] Welcome email sent to additional member:', memberEmail);
              }
            }
          } catch (credEmailError) {
            console.error('[AppProcessor] Error creating credentials for additional member:', credEmailError);
          }
        }
      }
      
      console.log('[AppProcessor] Additional members processed:', additionalMemberIds.length);
    }

    if (submission_id && (createdMemberId || createdOrganizationId || prefill_organization_id)) {
      // organization_id is the canonical link - use created org if available, otherwise prefilled org
      const finalOrganizationId = createdOrganizationId || prefill_organization_id || null;
      
      await supabase
        .from('form_submission')
        .update({
          created_member_id: createdMemberId,
          created_organization_id: createdOrganizationId,
          organization_id: finalOrganizationId,
          processed_at: new Date().toISOString()
        })
        .eq('id', submission_id);
    }

    // Return the resolved organization_id (whether created or existing)
    const resolvedOrganizationId = createdOrganizationId || prefill_organization_id || null;
    
    return res.json({
      success: true,
      created_member_id: createdMemberId,
      created_organization_id: createdOrganizationId,
      organization_id: resolvedOrganizationId, // Canonical org ID (created or existing)
      additional_member_ids: additionalMemberIds
    });
  } catch (error) {
    console.error('[AppProcessor] Error:', error);
    res.status(500).json({ error: 'Failed to process application' });
  }
}
