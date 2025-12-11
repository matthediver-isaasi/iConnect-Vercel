import { createClient } from '@supabase/supabase-js';
import { getSessionMember } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  // Require authentication - get member from session
  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required for field mappings' });
  }

  try {
    const { 
      form_values,     // The submitted form values { field_id: value }
      fields           // The form field definitions with custom_field_id mappings
    } = req.body;

    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'Invalid request: form_values is required' });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'Invalid request: fields array is required' });
    }

    const results = {
      member_updates: [],
      organization_updates: [],
      errors: []
    };

    // Get all preference field definitions
    const { data: preferenceFields, error: prefError } = await supabase
      .from('preference_field')
      .select('*')
      .eq('is_active', true);

    if (prefError) {
      console.error('[Field Mapping] Error fetching preference fields:', prefError);
      return res.status(500).json({ error: 'Failed to fetch preference field definitions' });
    }

    const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));

    // Process each field that has a custom_field_id mapping
    for (const field of fields) {
      if (!field.custom_field_id) continue;

      const customField = prefFieldMap.get(field.custom_field_id);
      if (!customField) {
        console.warn(`[Field Mapping] Custom field ${field.custom_field_id} not found`);
        continue;
      }

      const formValue = form_values[field.id];
      if (formValue === undefined || formValue === null || formValue === '') continue;

      // Convert value to appropriate format for storage
      let storedValue = formValue;
      if (customField.field_type === 'picklist' && Array.isArray(formValue)) {
        storedValue = JSON.stringify(formValue);
      } else if (typeof formValue === 'object') {
        storedValue = JSON.stringify(formValue);
      } else {
        storedValue = String(formValue);
      }

      const entityScope = customField.entity_scope || 'member';

      if (entityScope === 'member') {
        // Handle member preference value
        const { data: existing } = await supabase
          .from('member_preference_value')
          .select('id')
          .eq('member_id', member.id)
          .eq('field_id', customField.id)
          .maybeSingle();

        if (existing) {
          // Update existing
          const { error: updateError } = await supabase
            .from('member_preference_value')
            .update({ value: storedValue, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
          
          if (updateError) {
            results.errors.push(`Failed to update ${customField.label}: ${updateError.message}`);
          } else {
            results.member_updates.push(customField.label);
          }
        } else {
          // Create new
          const { error: createError } = await supabase
            .from('member_preference_value')
            .insert({
              member_id: member.id,
              field_id: customField.id,
              value: storedValue
            });
          
          if (createError) {
            results.errors.push(`Failed to create ${customField.label}: ${createError.message}`);
          } else {
            results.member_updates.push(customField.label);
          }
        }
      } else if (entityScope === 'organization' && member.organization_id) {
        // Handle organization preference value
        const { data: existing } = await supabase
          .from('organization_preference_value')
          .select('id')
          .eq('organization_id', member.organization_id)
          .eq('field_id', customField.id)
          .maybeSingle();

        if (existing) {
          // Update existing
          const { error: updateError } = await supabase
            .from('organization_preference_value')
            .update({ value: storedValue, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
          
          if (updateError) {
            results.errors.push(`Failed to update ${customField.label}: ${updateError.message}`);
          } else {
            results.organization_updates.push(customField.label);
          }
        } else {
          // Create new
          const { error: createError } = await supabase
            .from('organization_preference_value')
            .insert({
              organization_id: member.organization_id,
              field_id: customField.id,
              value: storedValue
            });
          
          if (createError) {
            results.errors.push(`Failed to create ${customField.label}: ${createError.message}`);
          } else {
            results.organization_updates.push(customField.label);
          }
        }
      } else if (entityScope === 'organization' && !member.organization_id) {
        // Skip if member has no organization
        console.log(`[Field Mapping] Skipping ${customField.label} - member has no organization_id`);
      }
    }

    console.log('[Field Mapping] Results:', results);
    return res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('[Field Mapping] Error processing mappings:', error);
    res.status(500).json({ error: 'Failed to process field mappings' });
  }
}
