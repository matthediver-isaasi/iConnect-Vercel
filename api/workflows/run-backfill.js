/**
 * Manual workflow backfill: run a workflow against ALL of the tenant's records.
 *
 * POST /api/workflows/run-backfill
 *   body: {
 *     workflow_id: string,
 *     mode: 'dry_run' | 'execute',
 *     offset?: number,     // resume cursor for chunked runs (default 0)
 *     page_size?: number   // records per invocation, 1..500 (default 200)
 *   }
 *
 * Runs ONE bounded chunk (reusing runScheduledWorkflow, which evaluates the
 * workflow's conditions against the *current* record state — no before-value)
 * and returns its summary { evaluated, matched, executed, skipped, errors,
 * complete, nextOffset }. The client re-invokes with `offset: nextOffset`
 * until `complete` is true, keeping each request well inside the serverless
 * duration limit regardless of tenant size.
 *
 * dry_run evaluates conditions and counts matches but executes no actions and
 * writes no logs. execute logs each run with trigger_type 'manual_backfill'
 * so manual runs are distinguishable in the execution logs tab.
 *
 * Workflows with change-based condition operators (changed_to / changed_from)
 * are rejected: those operators have no meaning without a before-value.
 *
 * Auth: tenant admin (getTenantContext + hasAdminAccess — NOT the
 * membership-only getTenantIdFromSession).
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { runScheduledWorkflow, getChangeBasedConditionOperators } from '../_lib/workflows.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context?.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const isAdmin = await hasAdminAccess(context);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { workflow_id: workflowId, mode, offset, page_size: pageSizeRaw } = req.body || {};

    if (!workflowId) {
      return res.status(400).json({ error: 'Missing workflow_id' });
    }
    if (mode !== 'dry_run' && mode !== 'execute') {
      return res.status(400).json({ error: "Invalid mode. Use 'dry_run' or 'execute'." });
    }

    const { data: workflow, error: wfError } = await supabase
      .from('workflow')
      .select('*')
      .eq('id', workflowId)
      .eq('tenant_id', context.tenantId)
      .maybeSingle();

    if (wfError) {
      console.error('[workflows/run-backfill] Workflow lookup failed:', wfError.message);
      return res.status(500).json({ error: 'Failed to load workflow' });
    }
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Change-based operators cannot be evaluated without a before-value.
    const changeOps = getChangeBasedConditionOperators(workflow);
    if (changeOps.length > 0) {
      return res.status(400).json({
        error: `This workflow uses change-based condition operators (${[...new Set(changeOps)].map(op => `"${op === 'changed_to' ? 'Changed To' : 'Changed From'}"`).join(', ')}) which compare a record's previous value to its new value. A backfill only sees each record's current value, so these conditions cannot be evaluated. Edit the workflow to use current-value operators (e.g. Equals / Contains) before running it against all records.`,
        code: 'change_operators_not_supported',
      });
    }

    let pageSize = Number(pageSizeRaw);
    if (!Number.isFinite(pageSize)) pageSize = 200;
    pageSize = Math.max(1, Math.min(500, Math.floor(pageSize)));

    let startOffset = Number(offset);
    if (!Number.isFinite(startOffset) || startOffset < 0) startOffset = 0;

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    let host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!host && process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    const baseUrl = host ? `${protocol}://${host}` : (process.env.VITE_APP_URL || '');

    const summary = await runScheduledWorkflow(workflow, baseUrl, {
      dryRun: mode === 'dry_run',
      offset: startOffset,
      recordLimit: pageSize,
      logTriggerType: 'manual_backfill',
    });

    return res.status(200).json({
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      mode,
      offset: startOffset,
      ...summary,
    });
  } catch (error) {
    console.error('[workflows/run-backfill] Error:', error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}
