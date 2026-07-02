// Task #1429 — hourly cron that runs "scheduled" workflows.
//
// Unlike event-driven workflows (fired by record create/update), scheduled
// workflows have no triggering record. This sweep loads every active workflow
// whose trigger_type === 'scheduled', decides whether each is due to run at
// the current tick (per-workflow frequency/run_time, evaluated in UTC), and
// for the due ones iterates the workflow's tenant records, evaluates its
// date/value conditions against the *current* record state, and executes the
// actions. once_per_record vs every_time semantics are honored exactly like
// the event-driven path.
//
// CRON_SECRET-guarded. Each workflow runs inside its own try/catch so a single
// failure cannot block the rest of the batch.

import { supabase } from '../_lib/database.js';
import { runScheduledWorkflow, isScheduledWorkflowDue } from '../_lib/workflows.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/run-scheduled-workflows] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const baseUrl = req.headers.host
    ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    : (process.env.VITE_APP_URL || '');

  const now = new Date();
  const results = {
    workflows_total: 0,
    workflows_due: 0,
    workflows_run: 0,
    evaluated: 0,
    matched: 0,
    executed: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    const { data: workflows, error } = await supabase
      .from('workflow')
      .select('*')
      .eq('trigger_type', 'scheduled')
      .eq('is_active', true);

    if (error) {
      console.error('[cron/run-scheduled-workflows] Failed to load workflows:', error.message);
      return res.status(500).json({ error: 'Failed to load workflows', detail: error.message });
    }

    results.workflows_total = workflows?.length || 0;

    for (const workflow of workflows || []) {
      if (!isScheduledWorkflowDue(workflow, now)) continue;
      results.workflows_due++;

      try {
        const summary = await runScheduledWorkflow(workflow, baseUrl);
        results.workflows_run++;
        results.evaluated += summary.evaluated;
        results.matched += summary.matched;
        results.executed += summary.executed;
        results.skipped += summary.skipped;
        results.errors += summary.errors;
        results.details.push({ workflow_id: workflow.id, name: workflow.name, ...summary });
      } catch (err) {
        results.errors++;
        console.error(`[cron/run-scheduled-workflows] Workflow ${workflow.id} failed: ${err.message}`);
        results.details.push({ workflow_id: workflow.id, name: workflow.name, error: err.message });
      }
    }

    results.duration_ms = Date.now() - startTime;
    console.log('[cron/run-scheduled-workflows] Done:', JSON.stringify({
      workflows_total: results.workflows_total,
      workflows_due: results.workflows_due,
      workflows_run: results.workflows_run,
      executed: results.executed,
      errors: results.errors,
      duration_ms: results.duration_ms,
    }));

    return res.status(200).json(results);
  } catch (err) {
    console.error('[cron/run-scheduled-workflows] Fatal error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
