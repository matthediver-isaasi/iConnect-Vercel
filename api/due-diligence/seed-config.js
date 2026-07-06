import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { remapFieldMappings } from '../_lib/fieldMappingRemap.js';

const supabaseUrl =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const supabaseKey =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null;

const CONFIG_CLONE_COLUMNS = [
  'scoring_approach',
  'scoring_rules',
  'static_questions',
  'custom_risk_levels',
  'default_review_state',
  'workflow_stages',
  'status_change_webhooks',
  'enforce_stage_sequence',
  'crm_attachment_config',
  'crm_logo_upload_config',
  'applicant_name_field',
  'applicant_email_field',
  'applicant_organization_name_field',
  'card_reference_field',
  'show_description_fields',
  'on_first_edit_stage',
  'owner_role_ids',
  'default_owner_name',
  'is_active',
];

const EMAIL_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'email_template_id',
  'recipient_email_field',
  'recipient_name_field',
  'cc_emails',
  'prompt_custom_message',
  'sort_order',
  'is_active',
];

const MEMBER_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'first_name_field',
  'last_name_field',
  'email_field',
  'field_mappings',
  'role_id',
  'welcome_email_template_id',
  'sort_order',
  'is_active',
  'login_enabled',
];

const FIELD_MAPPING_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'field_mappings',
  'sort_order',
  'is_active',
];

const ZOHO_CRM_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'field_mappings',
  'sort_order',
  'is_active',
];

const MEETING_REQUEST_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'meeting_template_id',
  'recipient_email_field',
  'first_name_field',
  'sort_order',
  'is_active',
];

function pickColumns(row, columns) {
  const out = {};
  for (const col of columns) {
    if (row[col] !== undefined) out[col] = row[col];
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tenantId = tenantCtx.tenantId;
  if (!tenantId || tenantId === 'undefined') {
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  const { sourceFormId, targetFormId } = req.body || {};
  if (!sourceFormId || !targetFormId) {
    return res.status(400).json({ error: 'sourceFormId and targetFormId are required' });
  }
  if (sourceFormId === targetFormId) {
    return res.status(400).json({ error: 'sourceFormId and targetFormId must differ' });
  }

  try {
    // Look up both forms (tenant guarded)
    const { data: forms, error: formsErr } = await supabase
      .from('form')
      .select('id, name, fields')
      .in('id', [sourceFormId, targetFormId])
      .eq('tenant_id', tenantId);
    if (formsErr) throw formsErr;

    const sourceForm = forms?.find(f => f.id === sourceFormId);
    const targetForm = forms?.find(f => f.id === targetFormId);
    if (!sourceForm) return res.status(404).json({ error: 'Source form not found in this tenant' });
    if (!targetForm) return res.status(404).json({ error: 'Target form not found in this tenant' });

    const sourceFormFields = sourceForm.fields || [];
    const targetFormFields = targetForm.fields || [];

    // Source config
    const { data: sourceConfigRows, error: srcCfgErr } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', sourceFormId)
      .eq('tenant_id', tenantId)
      .limit(1);
    if (srcCfgErr) throw srcCfgErr;
    const sourceConfig = sourceConfigRows?.[0];
    if (!sourceConfig) {
      return res.status(400).json({ error: 'Source form has no due diligence configuration to copy' });
    }

    // Existing target config (if any)
    const { data: targetCfgRows, error: tgtCfgErr } = await supabase
      .from('form_due_diligence_config')
      .select('id, workflow_stages')
      .eq('form_id', targetFormId)
      .eq('tenant_id', tenantId)
      .limit(1);
    if (tgtCfgErr) throw tgtCfgErr;
    const existingTargetConfig = targetCfgRows?.[0];

    // ============================================================
    // Read all source action rows up front
    // ============================================================
    const [srcEmail, srcMember, srcFm, srcZoho, srcMtg] = await Promise.all([
      supabase.from('stage_email_action').select('*')
        .eq('tenant_id', tenantId).eq('form_id', sourceFormId),
      supabase.from('stage_member_action').select('*')
        .eq('tenant_id', tenantId)
        .or(`form_id.eq.${sourceFormId},form_due_diligence_config_id.eq.${sourceConfig.id}`),
      supabase.from('stage_field_mapping_action').select('*')
        .eq('tenant_id', tenantId).eq('form_id', sourceFormId),
      supabase.from('stage_zoho_crm_action').select('*')
        .eq('tenant_id', tenantId).eq('form_id', sourceFormId),
      supabase.from('stage_meeting_request').select('*')
        .eq('tenant_id', tenantId)
        .or(`form_id.eq.${sourceFormId},form_due_diligence_config_id.eq.${sourceConfig.id}`),
    ]);
    for (const r of [srcEmail, srcMember, srcFm, srcZoho, srcMtg]) {
      if (r.error) throw r.error;
    }

    // ============================================================
    // Upsert target config
    // ============================================================
    const configPayload = pickColumns(sourceConfig, CONFIG_CLONE_COLUMNS);
    configPayload.tenant_id = tenantId;
    configPayload.form_id = targetFormId;
    configPayload.updated_at = new Date().toISOString();

    let targetConfigId;
    if (existingTargetConfig?.id) {
      const { data: upd, error: updErr } = await supabase
        .from('form_due_diligence_config')
        .update(configPayload)
        .eq('id', existingTargetConfig.id)
        .eq('tenant_id', tenantId)
        .select('id')
        .single();
      if (updErr) throw updErr;
      targetConfigId = upd.id;
    } else {
      const { data: ins, error: insErr } = await supabase
        .from('form_due_diligence_config')
        .insert(configPayload)
        .select('id')
        .single();
      if (insErr) throw insErr;
      targetConfigId = ins.id;
    }
    if (!targetConfigId) throw new Error('Failed to obtain target config id');

    // ============================================================
    // Delete target's existing stage actions (best-effort overwrite)
    // ============================================================
    const existingTargetConfigId = existingTargetConfig?.id || null;
    const deletions = await Promise.all([
      supabase.from('stage_email_action').delete()
        .eq('tenant_id', tenantId).eq('form_id', targetFormId),
      existingTargetConfigId
        ? supabase.from('stage_member_action').delete()
            .eq('tenant_id', tenantId)
            .or(`form_id.eq.${targetFormId},form_due_diligence_config_id.eq.${existingTargetConfigId}`)
        : supabase.from('stage_member_action').delete()
            .eq('tenant_id', tenantId).eq('form_id', targetFormId),
      supabase.from('stage_field_mapping_action').delete()
        .eq('tenant_id', tenantId).eq('form_id', targetFormId),
      supabase.from('stage_zoho_crm_action').delete()
        .eq('tenant_id', tenantId).eq('form_id', targetFormId),
      existingTargetConfigId
        ? supabase.from('stage_meeting_request').delete()
            .eq('tenant_id', tenantId)
            .or(`form_id.eq.${targetFormId},form_due_diligence_config_id.eq.${existingTargetConfigId}`)
        : supabase.from('stage_meeting_request').delete()
            .eq('tenant_id', tenantId).eq('form_id', targetFormId),
    ]);
    for (const r of deletions) {
      if (r.error) throw r.error;
    }

    // ============================================================
    // Bulk insert cloned rows
    // ============================================================
    const cloned = {
      email_actions: 0,
      member_actions: 0,
      field_mapping_actions: 0,
      zoho_crm_actions: 0,
      meeting_requests: 0,
    };

    if (srcEmail.data?.length) {
      const rows = srcEmail.data.map(r => ({
        ...pickColumns(r, EMAIL_ACTION_CLONE_COLUMNS),
        tenant_id: tenantId,
        form_id: targetFormId,
      }));
      const { error } = await supabase.from('stage_email_action').insert(rows);
      if (error) throw error;
      cloned.email_actions = rows.length;
    }

    if (srcMember.data?.length) {
      const rows = srcMember.data.map(r => ({
        ...pickColumns(r, MEMBER_ACTION_CLONE_COLUMNS),
        tenant_id: tenantId,
        form_id: targetFormId,
        form_due_diligence_config_id: targetConfigId,
      }));
      const { error } = await supabase.from('stage_member_action').insert(rows);
      if (error) throw error;
      cloned.member_actions = rows.length;
    }

    if (srcFm.data?.length) {
      let droppedMappings = 0;
      const rows = srcFm.data.map(r => {
        const picked = pickColumns(r, FIELD_MAPPING_ACTION_CLONE_COLUMNS);
        // Translate each mapping's source_field_id from the source form's field
        // to the target form's equivalent (by label, then name, then key) so the
        // copied mappings don't carry dangling source ids that point at fields
        // which only exist on the source form.
        const { mappings, dropped } = remapFieldMappings(
          picked.field_mappings || [],
          sourceFormFields,
          targetFormFields,
          { dropUnmatched: true }
        );
        droppedMappings += dropped.length;
        return {
          ...picked,
          field_mappings: mappings,
          tenant_id: tenantId,
          form_id: targetFormId,
        };
      // Skip actions left with no mappings after remapping (would violate the
      // NOT NULL / non-empty invariant enforced by the API on save).
      }).filter(row => Array.isArray(row.field_mappings) && row.field_mappings.length > 0);
      if (rows.length) {
        const { error } = await supabase.from('stage_field_mapping_action').insert(rows);
        if (error) throw error;
      }
      cloned.field_mapping_actions = rows.length;
      cloned.field_mappings_dropped = droppedMappings;
    }

    if (srcZoho.data?.length) {
      const rows = srcZoho.data.map(r => ({
        ...pickColumns(r, ZOHO_CRM_ACTION_CLONE_COLUMNS),
        tenant_id: tenantId,
        form_id: targetFormId,
      }));
      const { error } = await supabase.from('stage_zoho_crm_action').insert(rows);
      if (error) throw error;
      cloned.zoho_crm_actions = rows.length;
    }

    if (srcMtg.data?.length) {
      const rows = srcMtg.data.map(r => ({
        ...pickColumns(r, MEETING_REQUEST_CLONE_COLUMNS),
        tenant_id: tenantId,
        form_id: targetFormId,
        form_due_diligence_config_id: targetConfigId,
      }));
      const { error } = await supabase.from('stage_meeting_request').insert(rows);
      if (error) throw error;
      cloned.meeting_requests = rows.length;
    }

    // Mark target form as DD enabled
    const { error: formUpdErr } = await supabase
      .from('form')
      .update({ due_diligence_required: true })
      .eq('id', targetFormId)
      .eq('tenant_id', tenantId);
    if (formUpdErr) throw formUpdErr;

    return res.json({
      success: true,
      target_form_id: targetFormId,
      target_config_id: targetConfigId,
      cloned,
      source_form_name: sourceForm.name,
      target_form_name: targetForm.name,
    });
  } catch (err) {
    console.error('[dd seed-config] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
