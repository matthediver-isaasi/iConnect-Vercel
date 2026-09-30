import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  normalizeTargetEntity,
} from '../../shared/stageMemberMappingContract.js';
import {
  loadOwnedFormStage,
  requireStageMappingConfigAccess,
  sendStageMappingError,
  validateActionMappings,
} from '../_lib/stageFieldMappingApi.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

export function createStageFieldMappingActionsHandler(dependencies = {}) {
  const resolveTenantContext = dependencies.getTenantContext || getTenantContext;
  const makeClient = dependencies.createClient || createClient;
  const requireConfigAccess = dependencies.requireConfigAccess || (
    (tenantCtx, res) => requireStageMappingConfigAccess(tenantCtx, res, {
      hasAdminAccess: dependencies.hasAdminAccess,
      hasFeatureAccess: dependencies.hasFeatureAccess,
    })
  );
  const verifyFormStage = dependencies.loadOwnedFormStage || loadOwnedFormStage;
  const validateMappings = dependencies.validateActionMappings || validateActionMappings;
  const sendError = dependencies.sendStageMappingError || sendStageMappingError;
  const injectedSupabase = dependencies.supabase || null;

  return async function handler(req, res) {
    const tenantCtx = await resolveTenantContext(req);
    if (!(await requireConfigAccess(tenantCtx, res))) return;

    const tenantId = tenantCtx.tenantId;
    if (!tenantId || tenantId === 'undefined') {
      console.error('[stage-field-mapping-actions] Invalid tenantId:', tenantId);
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    if (!injectedSupabase && (!supabaseUrl || !supabaseServiceKey)) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const supabase = injectedSupabase || makeClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    if (req.method === 'GET') {
      try {
        const { stageId, formId } = req.query || {};
        if (stageId && stageId !== 'undefined' && (!formId || formId === 'undefined')) {
          return res.status(400).json({ error: 'formId is required when filtering by stageId' });
        }
        if (formId && formId !== 'undefined') {
          if (!stageId || stageId === 'undefined') {
            // A form-only list is valid; only verify the tenant-owned form.
            const formResult = await supabase.from('form')
              .select('id')
              .eq('id', formId)
              .eq('tenant_id', tenantId)
              .limit(1);
            if (formResult.error) {
              return res.status(500).json({ error: 'Failed to verify form ownership' });
            }
            if (!formResult.data?.[0]) return res.status(404).json({ error: 'Form not found in this tenant' });
          } else {
            const ownership = await verifyFormStage(supabase, {
              tenantId,
              formId,
              stageId,
            });
            if (!ownership.ok) return sendError(res, ownership);
          }
        }

        let query = supabase
          .from('stage_field_mapping_action')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('sort_order', { ascending: true });
        if (stageId && stageId !== 'undefined') query = query.eq('due_diligence_stage_id', stageId);
        if (formId && formId !== 'undefined') query = query.eq('form_id', formId);

        const { data, error } = await query;
        if (error) {
          console.error('[stage-field-mapping-actions] Fetch error:', error);
          return res.status(500).json({ error: 'Failed to fetch field mapping actions' });
        }
        const actions = (data || []).map((action) => ({
          ...action,
          target_entity: normalizeTargetEntity(action.target_entity) || 'organization',
        }));
        return res.json({ field_mapping_actions: actions });
      } catch (err) {
        console.error('[stage-field-mapping-actions] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    if (req.method === 'POST') {
      try {
        const {
          due_diligence_stage_id,
          field_mappings,
          sort_order,
          is_active,
          form_id,
          target_entity,
        } = req.body || {};

        if (!due_diligence_stage_id) return res.status(400).json({ error: 'Stage ID is required' });
        if (!form_id) return res.status(400).json({ error: 'form_id is required' });

        const ownership = await verifyFormStage(supabase, {
          tenantId,
          formId: form_id,
          stageId: due_diligence_stage_id,
        });
        if (!ownership.ok) return sendError(res, ownership);

        const normalizedTarget = normalizeTargetEntity(target_entity);
        const validation = await validateMappings(supabase, {
          tenantId,
          targetEntity: normalizedTarget,
          mappings: field_mappings,
          sourceFormFields: ownership.sourceFormFields,
        });
        if (!validation.ok) return sendError(res, validation);

        const { data, error } = await supabase
          .from('stage_field_mapping_action')
          .insert({
            tenant_id: tenantId,
            due_diligence_stage_id,
            field_mappings,
            target_entity: normalizedTarget,
            sort_order: sort_order || 0,
            is_active: is_active !== false,
            form_id,
          })
          .select()
          .single();

        if (error) {
          console.error('[stage-field-mapping-actions] Insert error:', error);
          return res.status(500).json({ error: 'Failed to create field mapping action' });
        }
        return res.status(201).json({
          field_mapping_action: {
            ...data,
            target_entity: normalizeTargetEntity(data?.target_entity) || normalizedTarget,
          },
        });
      } catch (err) {
        console.error('[stage-field-mapping-actions] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  };
}

export default createStageFieldMappingActionsHandler();