import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { requireSalesContext } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { OpportunityHttpError } from '../_lib/opportunityRules.js';
import { sendOpportunityError } from '../_lib/opportunityService.js';

const RESOURCES = {
  stages: { table: 'opportunity_stage', fields: ['name', 'position', 'color', 'probability', 'is_won', 'is_lost', 'is_active'] },
  'loss-reasons': { table: 'opportunity_loss_reason', fields: ['name', 'position', 'is_active'] },
};

export function createOpportunitySettingsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const adminAccess = dependencies.hasAdminAccess || hasAdminAccess;
  return async function handler(req, res) {
    try {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const context = await getContext(req);
      await requireSalesContext(context, req.method === 'GET'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_SETTINGS, dependencies);
      if (req.method !== 'GET' && !(await adminAccess(context))) {
        throw new OpportunityHttpError(403, 'Admin access required');
      }
      const config = RESOURCES[req.query.resource || 'stages'];
      if (!config) throw new OpportunityHttpError(400, 'Unknown settings resource');
      const isStages = config.table === 'opportunity_stage';
      if (req.method === 'GET') {
        const { data, error } = await db.from(config.table).select('*')
          .eq('tenant_id', context.tenantId).eq('is_active', true)
          .order('position').order('created_at').order('id');
        if (error) throw error;
        if (isStages) {
          const { data: pipeline, error: pipelineError } = await db
            .from('opportunity_pipeline_config').select('order_version')
            .eq('tenant_id', context.tenantId).maybeSingle();
          if (pipelineError) throw pipelineError;
          return res.status(200).json({ items: data || [], orderVersion: pipeline?.order_version || 1 });
        }
        return res.status(200).json({ items: data || [] });
      }
      const body = req.body || {};
      if (isStages && req.query.action === 'reorder') {
        if (req.method !== 'POST' || !Array.isArray(body.stageIds)
            || !Number.isInteger(body.expectedOrderVersion)) {
          throw new OpportunityHttpError(400, 'stageIds and expectedOrderVersion are required');
        }
        const { data, error } = await db.rpc('reorder_opportunity_stages', {
          p_tenant_id: context.tenantId,
          p_stage_ids: body.stageIds,
          p_expected_order_version: body.expectedOrderVersion,
        });
        if (error?.code === '40001') {
          throw new OpportunityHttpError(409, 'Pipeline order was updated by another user', 'STALE_UPDATE');
        }
        if (error) throw error;
        return res.status(200).json({ orderVersion: data });
      }
      if (req.method === 'POST') {
        // Stage position is an append-only server decision. It is never taken
        // from a client drag/drop payload; reordering uses the versioned RPC.
        const createFields = isStages ? config.fields.filter((key) => key !== 'position') : config.fields;
        const values = Object.fromEntries(createFields.filter((key) => key in body).map((key) => [key, body[key]]));
        if (isStages) {
          const { data, error } = await db.rpc('create_opportunity_stage', {
            p_tenant_id: context.tenantId,
            p_name: values.name,
            p_color: values.color || '#64748b',
            p_probability: values.probability ?? 0,
            p_is_won: values.is_won ?? false,
            p_is_lost: values.is_lost ?? false,
          });
          if (error) throw error;
          return res.status(201).json(data?.[0]);
        }
        const { data, error } = await db.from(config.table)
          .insert({ tenant_id: context.tenantId, ...values }).select('*').single();
        if (error) throw error;
        return res.status(201).json(data);
      }
      if (!req.query.id) throw new OpportunityHttpError(400, 'id is required');
      if (req.method === 'DELETE') {
        if (isStages) {
          const { count, error: referenceError } = await db.from('opportunity')
            .select('id', { count: 'exact', head: true }).eq('tenant_id', context.tenantId)
            .eq('stage_id', req.query.id);
          if (referenceError) throw referenceError;
          if (count) throw new OpportunityHttpError(409, 'Cannot deactivate a stage used by opportunities');
        }
        const { data, error } = await db.from(config.table).update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('tenant_id', context.tenantId).eq('id', req.query.id).select('*').maybeSingle();
        if (error) throw error;
        if (!data) throw new OpportunityHttpError(404, 'Setting not found');
        return res.status(200).json(data);
      }
      // Position is exclusively persisted by the versioned reorder RPC.
      const fields = config.table === 'opportunity_stage'
        ? config.fields.filter((key) => key !== 'position') : config.fields;
      const values = Object.fromEntries(fields.filter((key) => key in body).map((key) => [key, body[key]]));
      if (isStages && ('is_won' in values || 'is_lost' in values)) {
        const { data: currentStage, error: stageError } = await db.from('opportunity_stage')
          .select('id,is_won,is_lost,opportunity_count').eq('tenant_id', context.tenantId)
          .eq('id', req.query.id).maybeSingle();
        if (stageError) throw stageError;
        if (!currentStage) throw new OpportunityHttpError(404, 'Setting not found');
        const classificationChanges = (
          ('is_won' in values && values.is_won !== currentStage.is_won)
          || ('is_lost' in values && values.is_lost !== currentStage.is_lost)
        );
        if (currentStage.opportunity_count > 0 && classificationChanges) {
          throw new OpportunityHttpError(
            409, 'Cannot change won/lost classification of a stage used by opportunities',
          );
        }
      }
      values.updated_at = new Date().toISOString();
      const { data, error } = await db.from(config.table).update(values)
        .eq('tenant_id', context.tenantId).eq('id', req.query.id).select('*').maybeSingle();
      if (error) throw error;
      if (!data) throw new OpportunityHttpError(404, 'Setting not found');
      return res.status(200).json(data);
    } catch (error) {
      return sendOpportunityError(res, error, 'Failed to handle opportunity settings');
    }
  };
}

export default createOpportunitySettingsHandler();