import {
  hasAdminAccess,
  hasFeatureAccess,
} from './tenantContext.js';
import {
  normalizeTargetEntity,
  validateStageFieldMappings,
} from '../../shared/stageMemberMappingContract.js';

export const DUE_DILIGENCE_CONFIG_PERMISSION = 'forms.due-diligence-config';

export async function requireStageMappingConfigAccess(tenantCtx, res, dependencies = {}) {
  if (!tenantCtx?.isAuthenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const isAdmin = await (dependencies.hasAdminAccess || hasAdminAccess)(tenantCtx);
  const hasFeature = tenantCtx.roleId
    ? await (dependencies.hasFeatureAccess || hasFeatureAccess)(
      tenantCtx.roleId,
      DUE_DILIGENCE_CONFIG_PERMISSION,
      tenantCtx.memberExcludedFeatures || [],
    )
    : false;
  if (!isAdmin && !hasFeature) {
    res.status(403).json({ error: 'Access denied - requires due diligence config permission' });
    return false;
  }
  return true;
}

async function queryRows(query) {
  const result = await query;
  return result || { data: null, error: null };
}

function stageInConfig(config, stageId) {
  return (Array.isArray(config?.workflow_stages) ? config.workflow_stages : [])
    .find((stage) => String(stage?.id) === String(stageId));
}

/**
 * Verify that the form, due-diligence config, and workflow stage all belong
 * to this tenant. This is intentionally server-side even though stage ids
 * are embedded in workflow_stages JSON.
 */
export async function loadOwnedFormStage(supabase, {
  tenantId,
  formId,
  stageId,
}) {
  if (!formId) {
    return { ok: false, status: 400, error: 'form_id is required' };
  }
  if (!stageId) {
    return { ok: false, status: 400, error: 'Stage ID is required' };
  }

  const formResult = await queryRows(
    supabase.from('form')
      .select('id, fields')
      .eq('id', formId)
      .eq('tenant_id', tenantId)
      .limit(1),
  );
  if (formResult.error) return { ok: false, status: 500, error: 'Failed to verify form ownership', cause: formResult.error };
  const form = formResult.data?.[0] || null;
  if (!form) return { ok: false, status: 404, error: 'Form not found in this tenant' };

  const configResult = await queryRows(
    supabase.from('form_due_diligence_config')
      .select('id, form_id, workflow_stages')
      .eq('form_id', formId)
      .eq('tenant_id', tenantId)
      .limit(1),
  );
  if (configResult.error) return { ok: false, status: 500, error: 'Failed to verify stage ownership', cause: configResult.error };
  const config = configResult.data?.[0] || null;
  if (!config) return { ok: false, status: 404, error: 'Due diligence configuration not found for this form' };
  const stage = stageInConfig(config, stageId);
  if (!stage) return { ok: false, status: 404, error: 'Stage does not belong to this form' };

  return {
    ok: true,
    form,
    config,
    stage,
    sourceFormFields: Array.isArray(form.fields) ? form.fields : [],
  };
}

/**
 * Legacy rows may not have form_id. Resolve their stage against tenant-owned
 * configs rather than trusting a client supplied form id.
 */
export async function loadOwnedActionScope(supabase, {
  tenantId,
  action,
  formId = null,
}) {
  const effectiveFormId = formId || action?.form_id || null;
  if (effectiveFormId) {
    return loadOwnedFormStage(supabase, {
      tenantId,
      formId: effectiveFormId,
      stageId: action?.due_diligence_stage_id,
    });
  }

  const configsResult = await queryRows(
    supabase.from('form_due_diligence_config')
      .select('id, form_id, workflow_stages')
      .eq('tenant_id', tenantId),
  );
  if (configsResult.error) {
    return { ok: false, status: 500, error: 'Failed to verify stage ownership', cause: configsResult.error };
  }
  const matches = (configsResult.data || [])
    .filter((config) => stageInConfig(config, action?.due_diligence_stage_id));
  if (matches.length === 0) {
    return { ok: false, status: 404, error: 'Stage does not belong to this tenant' };
  }
  if (matches.length > 1) {
    return { ok: false, status: 409, error: 'Stage ownership is ambiguous; specify the form' };
  }
  return loadOwnedFormStage(supabase, {
    tenantId,
    formId: matches[0].form_id,
    stageId: action?.due_diligence_stage_id,
  });
}

export async function loadPreferenceDefinitions(supabase, {
  tenantId,
  mappings = [],
}) {
  const ids = [...new Set((mappings || [])
    .filter((mapping) => mapping?.target_type === 'custom' && mapping.target_field)
    .map((mapping) => String(mapping.target_field)))];
  if (ids.length === 0) return { data: [], error: null };
  return queryRows(
    supabase.from('preference_field')
      // Optional writability metadata must be preserved when present, not
      // named in the projection: older schemas do not define those columns.
      .select('*')
      .eq('tenant_id', tenantId)
      .in('id', ids),
  );
}

export async function validateActionMappings(supabase, {
  tenantId,
  targetEntity,
  mappings,
  sourceFormFields,
}) {
  const normalizedTarget = normalizeTargetEntity(targetEntity);
  if (!normalizedTarget) {
    return { ok: false, status: 400, error: 'target_entity must be "organization" or "member"' };
  }
  const preferenceResult = await loadPreferenceDefinitions(supabase, {
    tenantId,
    mappings,
  });
  if (preferenceResult.error) {
    return { ok: false, status: 500, error: 'Failed to verify preference field ownership', cause: preferenceResult.error };
  }
  const validation = validateStageFieldMappings(mappings, {
    targetEntity: normalizedTarget,
    preferenceFields: preferenceResult.data || [],
    sourceFields: sourceFormFields,
    tenantId,
    requireCustomFieldDefinition: true,
  });
  return validation.ok
    ? { ok: true, targetEntity: normalizedTarget }
    : { ok: false, status: 400, error: validation.errors[0], errors: validation.errors };
}

export function sendStageMappingError(res, result) {
  if (result?.cause) {
    console.error('[stage-field-mapping-actions] Ownership/validation query failed:', result.cause);
  }
  return res.status(result?.status || 400).json({
    error: result?.error || 'Invalid field mapping action',
    ...(result?.errors ? { errors: result.errors } : {}),
  });
}
