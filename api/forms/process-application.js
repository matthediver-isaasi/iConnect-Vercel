import { createClient } from '@supabase/supabase-js';

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

  try {
    const { 
      form_id,
      form_values,
      fields,
      application_level,
      submission_id
    } = req.body;

    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'form_values is required' });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields array is required' });
    }

    if (!application_level || !['member', 'organization'].includes(application_level)) {
      return res.status(400).json({ error: 'Valid application_level is required (member or organization)' });
    }

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
    const memberCustomFields = [];
    const orgCustomFields = [];

    const { data: preferenceFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('is_active', true);

    const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));

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
          let storedValue = value;
          if (Array.isArray(value)) {
            storedValue = JSON.stringify(value);
          } else if (typeof value === 'object') {
            storedValue = JSON.stringify(value);
          } else {
            storedValue = String(value);
          }

          if (customField.entity_scope === 'organization') {
            orgCustomFields.push({ field_id: customField.id, value: storedValue });
          } else {
            memberCustomFields.push({ field_id: customField.id, value: storedValue });
          }
        }
      }
    }

    console.log('[AppProcessor] Extracted data:', { memberData, orgData, memberCustomFields: memberCustomFields.length, orgCustomFields: orgCustomFields.length });

    let createdOrganizationId = null;
    let createdMemberId = null;

    if (Object.keys(orgData).length > 0 || application_level === 'organization') {
      // Check for existing organization by name
      let existingOrg = null;
      if (orgData.name) {
        const { data: foundOrg } = await supabase
          .from('organization')
          .select('id')
          .ilike('name', orgData.name)
          .limit(1)
          .single();
        existingOrg = foundOrg;
      }
      
      if (existingOrg) {
        createdOrganizationId = existingOrg.id;
        console.log('[AppProcessor] Found existing organization:', createdOrganizationId);
      } else {
        const orgInsertData = {
          name: orgData.name || 'New Organisation',
          invoicing_email: orgData.invoicing_email || null,
          phone: orgData.phone || null,
          website_url: orgData.website_url || null,
          status: 'active',
          created_at: new Date().toISOString()
        };

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

      for (const cf of orgCustomFields) {
        await supabase.from('organization_preference_value').insert({
          organization_id: createdOrganizationId,
          field_id: cf.field_id,
          value: cf.value
        });
      }
    }

    if (memberData.email || application_level === 'member') {
      // Check for existing member by email
      let existingMember = null;
      if (memberData.email) {
        const { data: foundMember } = await supabase
          .from('member')
          .select('id')
          .ilike('email', memberData.email)
          .limit(1)
          .single();
        existingMember = foundMember;
      }

      if (existingMember) {
        createdMemberId = existingMember.id;
        console.log('[AppProcessor] Found existing member:', createdMemberId);
      } else {
        if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
          const nameParts = memberData.full_name.trim().split(/\s+/);
          memberData.first_name = nameParts[0] || '';
          memberData.last_name = nameParts.slice(1).join(' ') || '';
        }

        const memberInsertData = {
          email: memberData.email || `pending-${Date.now()}@example.com`,
          first_name: memberData.first_name || '',
          last_name: memberData.last_name || '',
          full_name: memberData.full_name || `${memberData.first_name || ''} ${memberData.last_name || ''}`.trim(),
          job_title: memberData.job_title || null,
          phone: memberData.phone || null,
          organization_id: createdOrganizationId,
          status: 'active',
          created_at: new Date().toISOString(),
          source: 'application_form'
        };

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

      for (const cf of memberCustomFields) {
        await supabase.from('member_preference_value').insert({
          member_id: createdMemberId,
          field_id: cf.field_id,
          value: cf.value
        });
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
