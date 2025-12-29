import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { sendEmail } from '../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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
      entity_pipelines             // New unified structure: {members: [], organisations: []}
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
    // If entity_pipelines has entries, use that; otherwise fall back to legacy fields
    const validActions = ['none', 'create', 'update', 'upsert'];
    
    let memberAction;
    let orgAction;
    
    if (memberPipelines.length > 0) {
      // New entity_pipelines system - always use 'upsert' mode for pipeline entries
      memberAction = 'upsert';
    } else if (member_entity_action && validActions.includes(member_entity_action)) {
      memberAction = member_entity_action;
    } else {
      // Legacy fallback
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'member' || legacyEntityType === 'both') {
        memberAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        memberAction = 'none';
      }
    }
    
    if (orgPipelines.length > 0) {
      // New entity_pipelines system - always use 'upsert' mode for pipeline entries
      orgAction = 'upsert';
    } else if (organization_entity_action && validActions.includes(organization_entity_action)) {
      orgAction = organization_entity_action;
    } else {
      // Legacy fallback
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

    const memberData = {};
    const orgData = {};
    // Use Maps to aggregate values for list fields
    const memberCustomFieldsMap = new Map();
    const orgCustomFieldsMap = new Map();

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
        // Add value if not already present (dedupe)
        if (!arr.includes(value)) {
          arr.push(value);
        }
      } else {
        // For non-list fields, just store the value (last one wins)
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
          if (value === undefined || value === null || value === '') continue;
          
          // Apply transformation only for field mappings
          if (transformation && transformation !== 'none') {
            value = applyTransformation(value, transformation);
          }
        }
        
        if (target_type === 'core') {
          if (target_entity === 'member') {
            memberData[target_field] = value;
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
        if (value === undefined || value === null || value === '') continue;

        if (field.core_field_mapping) {
          const [entity, fieldName] = field.core_field_mapping.split('.');
          if (entity === 'member') {
            memberData[fieldName] = value;
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
            if (value !== undefined && value !== null && value !== '') {
              dataObj[dbKey] = value;
            }
          } else if (mapping.target_type === 'custom') {
            // Custom field
            const customFieldId = mapping.target_field;
            const prefField = prefFieldMap.get(customFieldId);
            if (value !== undefined && value !== null && value !== '') {
              addCustomFieldValue(customFieldsMap, customFieldId, value, prefField);
            }
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
            if (val !== undefined && val !== null && val !== '') {
              dataObj[dbKey] = val;
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
      const primaryMemberPipeline = memberPipelines.find(m => m.isPrimary);
      const memberCoreFieldMappings = {
        'email': 'email',
        'first_name': 'first_name',
        'last_name': 'last_name',
        'phone': 'mobile',
        'job_title': 'job_title'
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
      const primaryOrgPipeline = orgPipelines.find(o => o.isPrimary);
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
          
          // Add role_id: first check pipeline config, then form conditional logic
          if (memberData.role_id !== undefined) {
            memberUpdateData.role_id = memberData.role_id;
            console.log('[AppProcessor] Adding pipeline role_id to member update:', memberData.role_id);
          } else if (role_id !== undefined) {
            memberUpdateData.role_id = role_id;
            console.log('[AppProcessor] Adding conditional logic role_id to member update:', role_id);
          }
          
          // Add login_enabled from pipeline config if specified
          if (memberData.login_enabled !== undefined) {
            memberUpdateData.login_enabled = memberData.login_enabled;
            console.log('[AppProcessor] Adding pipeline login_enabled to member update:', memberData.login_enabled);
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
          
          // Use createdOrganizationId if org was created/updated, otherwise use prefill_organization_id
          const orgIdForNewMember = createdOrganizationId || prefill_organization_id || null;

          // Note: member table doesn't have phone or status columns
          const memberInsertData = {
            email: memberData.email,
            first_name: memberData.first_name || '',
            last_name: memberData.last_name || '',
            organization_id: orgIdForNewMember,
            login_enabled: memberData.login_enabled !== undefined ? memberData.login_enabled : true
          };
          // Add job_title only if provided (it's a valid column)
          if (memberData.job_title) memberInsertData.job_title = memberData.job_title;
          // Add mobile and landline if provided
          if (memberData.mobile) memberInsertData.mobile = memberData.mobile;
          if (memberData.landline) memberInsertData.landline = memberData.landline;
          
          // Add role_id: first check pipeline config, then form conditional logic
          if (memberData.role_id !== undefined) {
            memberInsertData.role_id = memberData.role_id;
            console.log('[AppProcessor] Adding pipeline role_id to member insert:', memberData.role_id);
          } else if (role_id !== undefined) {
            // Fallback to form conditional logic role_id
            memberInsertData.role_id = role_id;
            console.log('[AppProcessor] Adding conditional logic role_id to member insert:', role_id);
          } else {
            console.log('[AppProcessor] No role_id specified for member insert');
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
          
          // Generate temporary password and send welcome email
          try {
            // Generate a random 12-character temporary password
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            let tempPassword = '';
            for (let i = 0; i < 12; i++) {
              tempPassword += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            
            // Hash the password
            const passwordHash = await bcrypt.hash(tempPassword, 12);
            
            // Store in member_credentials table
            const { error: credError } = await supabase
              .from('member_credentials')
              .insert({
                member_id: createdMemberId,
                email: memberData.email.toLowerCase(),
                password_hash: passwordHash,
                is_temp_password: true,
                password_set_at: new Date().toISOString()
              });
            
            if (credError) {
              console.error('[AppProcessor] Failed to create credentials:', credError);
            } else {
              console.log('[AppProcessor] Created temporary credentials for member:', createdMemberId);
              
              // Get system settings for app name, login URL, and email from address
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
              
              // Send welcome email with temporary password
              const emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Welcome to ${appName}!</h2>
                  <p>Your account has been created. Here are your login details:</p>
                  <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Email:</strong> ${memberData.email}</p>
                    <p><strong>Temporary Password:</strong> <code style="background-color: #e0e0e0; padding: 4px 8px; border-radius: 4px;">${tempPassword}</code></p>
                  </div>
                  <p>Please log in and change your password as soon as possible.</p>
                  <p style="margin-top: 20px;">
                    <a href="${loginUrl}/login" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                      Log In Now
                    </a>
                  </p>
                  <p style="margin-top: 30px; color: #666; font-size: 14px;">
                    If you did not request this account, please ignore this email.
                  </p>
                </div>
              `;
              
              const emailResult = await sendEmail({
                to: memberData.email,
                subject: `Welcome to ${appName} - Your Login Details`,
                html: emailHtml,
                from: `${fromName} <${fromAddress}>`
              });
              
              if (emailResult.success) {
                console.log('[AppProcessor] Welcome email sent to:', memberData.email);
              } else {
                console.error('[AppProcessor] Failed to send welcome email:', emailResult.error);
              }
            }
          } catch (credEmailError) {
            console.error('[AppProcessor] Error creating credentials/sending email:', credEmailError);
            // Don't fail the whole process if email fails
          }
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

    // Process member pipelines (additional members) with sequential upsert logic
    // Use entity_pipelines.members if available, fall back to legacy additional_member_creations
    // Track processed emails to handle same email appearing in multiple member configs
    const processedEmails = new Map(); // email -> member_id
    
    // If primary member was created/updated, track its email
    if (createdMemberId) {
      const primaryEmail = memberData?.email?.toLowerCase();
      if (primaryEmail) {
        processedEmails.set(primaryEmail, createdMemberId);
        console.log('[AppProcessor] Tracking primary member email:', primaryEmail, '->', createdMemberId);
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
          'job_title': 'job_title'
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
              if (value !== undefined && value !== null && value !== '') {
                additionalMemberData[dbKey] = value;
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
            } else if (form_values[fieldId] !== undefined && form_values[fieldId] !== null && form_values[fieldId] !== '') {
              additionalMemberData[dbKey] = form_values[fieldId];
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
        let existingMemberId = processedEmails.get(normalizedEmail);
        let isNewMember = false;
        
        if (!existingMemberId) {
          // Check if member exists in database
          const { data: existingMember } = await supabase
            .from('member')
            .select('id')
            .ilike('email', normalizedEmail)
            .limit(1)
            .single();
          
          if (existingMember) {
            existingMemberId = existingMember.id;
            console.log('[AppProcessor] Found existing member in DB:', normalizedEmail, '->', existingMemberId);
          }
        }
        
        if (existingMemberId) {
          // UPDATE existing member - merge fields, don't clear unless explicitly requested
          console.log('[AppProcessor] Updating existing member:', existingMemberId, 'with:', additionalMemberData);
          
          if (Object.keys(additionalMemberData).length > 0) {
            const { error: updateError } = await supabase
              .from('member')
              .update(additionalMemberData)
              .eq('id', existingMemberId);
            
            if (updateError) {
              console.error('[AppProcessor] Failed to update additional member:', updateError);
            } else {
              console.log('[AppProcessor] Updated member:', existingMemberId);
            }
          }
          
          additionalMemberIds.push({ id: existingMemberId, label: memberConfig.label, created: false, updated: true });
          processedEmails.set(normalizedEmail, existingMemberId);
        } else {
          // CREATE new member
          isNewMember = true;
          const newMemberData = {
            email: memberEmail,
            login_enabled: additionalMemberData.login_enabled !== undefined ? additionalMemberData.login_enabled : true,
            organization_id: createdOrganizationId || prefill_organization_id || null,
            ...additionalMemberData
          };
          
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
          processedEmails.set(normalizedEmail, newMember.id);
          console.log('[AppProcessor] Created additional member:', newMember.id);
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
                  from: `${fromName} <${fromAddress}>`
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

    if (submission_id && (createdMemberId || createdOrganizationId)) {
      await supabase
        .from('form_submission')
        .update({
          created_member_id: createdMemberId,
          created_organization_id: createdOrganizationId,
          processed_at: new Date().toISOString()
        })
        .eq('id', submission_id);
    }

    return res.json({
      success: true,
      created_member_id: createdMemberId,
      created_organization_id: createdOrganizationId,
      additional_member_ids: additionalMemberIds
    });
  } catch (error) {
    console.error('[AppProcessor] Error:', error);
    res.status(500).json({ error: 'Failed to process application' });
  }
}
