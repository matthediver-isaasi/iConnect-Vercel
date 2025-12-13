import { createClient } from '@supabase/supabase-js';

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
      member_entity_action,        // New: independent member action (none/create/update/upsert)
      organization_entity_action,  // New: independent organization action (none/create/update/upsert)
      prefill_member_id,
      prefill_organization_id,
      submission_id,
      role_id                      // Role ID from form conditional logic (set_role action)
    } = req.body;

    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'form_values is required' });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields array is required' });
    }

    // Validate entity action values
    const validActions = ['none', 'create', 'update', 'upsert'];
    
    // Support new independent action fields with fallback to legacy fields
    let memberAction = member_entity_action;
    let orgAction = organization_entity_action;
    
    // Fallback to legacy fields if new ones aren't provided
    if (!memberAction || !validActions.includes(memberAction)) {
      // Legacy fallback
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'member' || legacyEntityType === 'both') {
        memberAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        memberAction = 'none';
      }
    }
    
    if (!orgAction || !validActions.includes(orgAction)) {
      // Legacy fallback
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'organization' || legacyEntityType === 'both') {
        orgAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        orgAction = 'none';
      }
    }
    
    // Determine processing flags based on new action values
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

    // Process new field_mappings array first (preferred method)
    if (field_mappings && Array.isArray(field_mappings) && field_mappings.length > 0) {
      console.log('[AppProcessor] Using field_mappings:', field_mappings.length, 'mappings');
      
      for (const mapping of field_mappings) {
        const { source_type, source_field_id, static_value, target_type, target_entity, target_field, transformation } = mapping;
        
        // Skip if no target field
        if (!target_field) continue;
        
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

    const orgCustomFields = convertMapToArray(orgCustomFieldsMap);
    const memberCustomFields = convertMapToArray(memberCustomFieldsMap);

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
          // Add role_id if triggered from form conditional logic (null clears the role)
          if (role_id !== undefined) memberUpdateData.role_id = role_id;
          
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
            login_enabled: true
          };
          // Add job_title only if provided (it's a valid column)
          if (memberData.job_title) memberInsertData.job_title = memberData.job_title;
          // Add role_id if triggered from form conditional logic (null clears the role)
          if (role_id !== undefined) {
            memberInsertData.role_id = role_id;
            console.log('[AppProcessor] Adding role_id to member insert:', role_id);
          } else {
            console.log('[AppProcessor] role_id is undefined, not adding to member insert');
          }

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
      created_organization_id: createdOrganizationId
    });
  } catch (error) {
    console.error('[AppProcessor] Error:', error);
    res.status(500).json({ error: 'Failed to process application' });
  }
}
