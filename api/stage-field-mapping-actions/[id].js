import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  normalizeTargetEntity,
} from '../../shared/stageMemberMappingContract.js';
import {
  loadOwnedActionScope,
  requireStageMappingConfigAccess,
  sendStageMappingError,
  validateActionMappings,
} from '../_lib/stageFieldMappingApi.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function loadAction(supabase, tenantId, id) {
  const result = await supabase
    .from('stage_field_mapping_action')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .limit(1);
  if (result.error) return { error: result.error };
  return { action: result.data?.[0] || null };
}

export function createStageFieldMappingActionHandler(dependencies = {}) {
  const resolveTenantContext = dependencies.getTenantContext || getTenantContext;
  const makeClient = dependencies.createClient || createClient;
  const requireConfigAccess = dependencies.requireConfigAccess || (
    (tenantCtx, res) => requireStageMappingConfigAccess(tenantCtx, res, {
      hasAdminAccess: dependencies.hasAdminAccess,
      hasFeatureAccess: dependencies.hasFeatureAccess,
    })
  );
  const loadActionScope = dependencies.loadOwnedActionScope || loadOwnedActionScope;
  const validateMappings = dependencies.validateActionMappings || validateActionMappings;
  const sendError = dependencies.sendStageMappingError || sendStageMappingError;
  const injectedSupabase = dependencies.supabase || null;

  return async function handler(req, res) {
    const tenantCtx = await resolveTenantContext(req);
    if (!(await requireConfigAccess(tenantCtx, res))) return;

    const tenantId = tenantCtx.tenantId;
    const { id } = req.query || {};
    if (!tenantId || tenantId === 'undefined') return res.status(400).json({ error: 'Invalid tenant context' });
    if (!id) return res.status(400).json({ error: 'ID is required' });
    if (!injectedSupabase && (!supabaseUrl || !supabaseServiceKey)) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const supabase = injectedSupabase || makeClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    try {
      const loaded = await loadAction(supabase, tenantId, id);
      if (loaded.error) {
        console.error('[stage-field-mapping-actions] Fetch error:', loaded.error);
        return res.status(500).json({ error: 'Failed to fetch field mapping action' });
      }
      if (!loaded.action) return res.status(404).json({ error: 'Field mapping action not found' });
      const action = loaded.action;

      const ownership = await loadActionScope(supabase, {
        tenantId,
        action,
      });
      if (!ownership.ok) return sendError(res, ownership);

      if (req.method === 'GET') {
        return res.json({
          field_mapping_action: {
            ...action,
            target_entity: normalizeTargetEntity(action.target_entity) || 'organization',
          },
        });
      }

      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = req.body || {};
        const mappings = body.field_mappings === undefined
          ? action.field_mappings
          : body.field_mappings;
        const targetEntity = body.target_entity === undefined
          ? normalizeTargetEntity(action.target_entity)
          : normalizeTargetEntity(body.target_entity);
        const validation = await validateMappings(supabase, {
          tenantId,
          targetEntity,
          mappings,
          sourceFormFields: ownership.sourceFormFields,
        });
        if (!validation.ok) return sendError(res, validation);

        const updateData = {
          target_entity: targetEntity,
          field_mappings: mappings,
        };
        if (body.sort_order !== undefined) updateData.sort_order = body.sort_order;
        if (body.is_active !== undefined) updateData.is_active = body.is_active;

        const { data, error } = await supabase
          .from('stage_field_mapping_action')
          .update(updateData)
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .select()
          .single();
        if (error) {
          console.error('[stage-field-mapping-actions] Update error:', error);
          return res.status(500).json({ error: 'Failed to update field mapping action' });
        }
        return res.json({
          field_mapping_action: {
            ...data,
            target_entity: normalizeTargetEntity(data?.target_entity) || targetEntity,
          },
        });
      }

      if (req.method === 'DELETE') {
        const { error } = await supabase
          .from('stage_field_mapping_action')
          .delete()
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) {
          console.error('[stage-field-mapping-actions] Delete error:', error);
          return res.status(500).json({ error: 'Failed to delete field mapping action' });
        }
        return res.json({ success: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createStageFieldMappingActionHandler();