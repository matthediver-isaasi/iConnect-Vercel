import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';
import { parseImportFile } from '../_lib/importFileParser.js';
import { processImportSlice } from '../_lib/importProcessor.js';

// How long a single invocation is allowed to spend processing rows before it
// stops and asks the client to continue from the returned cursor. Kept well
// under the 60s function ceiling to leave comfortable headroom for parsing, the
// per-slice auxiliary writes (custom fields / comm prefs / notes), and the final
// response, so a single chunk is very unlikely to hit the platform timeout.
const CHUNK_TIME_BUDGET_MS = 30000;

// --- Import job history helpers -------------------------------------------
// Each import run is recorded in csv_import_job so the "Recent Imports" panel
// can show history and offer "reuse setup". Writes are best-effort: a logging
// failure must never abort the import itself.
async function startImportJob({ tenantId, entityType, fileName, totalRows, mappings, identifierField }) {
  try {
    const activeMappings = (mappings || []).filter((m) => m && m.targetField);
    const { data: job, error } = await supabase
      .from('csv_import_job')
      .insert({
        tenant_id: tenantId,
        entity_type: entityType,
        status: 'running',
        file_name: fileName,
        total_rows: totalRows,
        identifier_field: identifierField,
        mappings: activeMappings,
      })
      .select('id')
      .single();
    if (error) {
      console.log('[Import] Could not create job record:', error.message);
      return null;
    }
    return job?.id || null;
  } catch (e) {
    console.log('[Import] Could not create job record:', e.message);
    return null;
  }
}

// Persist running progress to the job row. Counts are CUMULATIVE across chunks
// (the client carries the running totals and re-sends them, the server adds the
// chunk deltas before calling this). `newErrors` are this chunk's errors, which
// are appended to the existing list (capped) so the final record keeps a sample
// from every chunk. Best-effort: never abort the import on a logging failure.
async function updateImportJobProgress(jobId, { created = 0, updated = 0, errors = 0, newErrors = [], done = false } = {}) {
  if (!jobId) return;
  try {
    const processed = created + updated;
    const update = {
      status: done ? (errors > 0 ? 'completed_with_errors' : 'completed') : 'running',
      processed_count: processed,
      success_count: processed,
      created_count: created,
      updated_count: updated,
      error_count: errors,
      updated_at: new Date().toISOString(),
    };
    if (Array.isArray(newErrors) && newErrors.length > 0) {
      const { data: existing } = await supabase
        .from('csv_import_job')
        .select('errors')
        .eq('id', jobId)
        .single();
      const prev = Array.isArray(existing?.errors) ? existing.errors : [];
      update.errors = prev.concat(newErrors).slice(0, 100);
    }
    await supabase
      .from('csv_import_job')
      .update(update)
      .eq('id', jobId);
  } catch (e) {
    console.log('[Import] Could not update job record:', e.message);
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60, // Increase timeout to 60 seconds for Pro plans
};

// Legacy browser-driven import endpoint. Kept for backward compatibility: it
// processes one time-budgeted slice per request and returns a cursor so a
// client loop can continue. The current Import Manager UI uses the background
// job flow (api/imports/enqueue.js + the cron worker) instead, but both share
// the same slice processor (api/_lib/importProcessor.js).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let importTenantId = null;
  try {
    const { data: sessionMember } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', session.data.memberId)
      .single();
    importTenantId = sessionMember?.tenant_id || null;
  } catch (e) {
    console.log('[Import] Could not resolve tenant_id from session member:', e.message);
  }

  // Members and organizations are tenant-scoped. Without a tenant we would
  // create rows invisible to every tenant-scoped view (the original bug), so
  // fail clearly instead of silently importing orphaned records.
  if (!importTenantId) {
    return res.status(400).json({
      error: 'Could not determine your organisation for this import. Please sign out and back in, then try again.'
    });
  }

  // The cursor is carried by the client across chunk calls. Declared in the
  // outer scope so the catch handler can mark the right job record as failed.
  let jobId = null;
  let offset = 0;

  try {
    const { file, fields } = await parseMultipartForm(req);

    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { entityType, identifierField, mappings: mappingsStr } = fields;
    const mappings = mappingsStr ? JSON.parse(mappingsStr) : [];

    if (!entityType || !identifierField || !mappings.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Resumable cursor + running totals. The client re-sends the (already held)
    // file each chunk along with the prior response's offset, jobId, and totals
    // so each invocation processes only a time-budgeted slice of rows.
    offset = Math.max(0, parseInt(fields.offset, 10) || 0);
    const incomingJobId = fields.jobId || null;
    // Once the SQL fast path has fallen back to the JS path, the client echoes
    // `forcePath=js` so every later chunk stays on the JS path.
    const forceJsPath = fields.forcePath === 'js';
    const runningCreated = Math.max(0, parseInt(fields.created, 10) || 0);
    const runningUpdated = Math.max(0, parseInt(fields.updated, 10) || 0);
    const runningSkipped = Math.max(0, parseInt(fields.skipped, 10) || 0);
    const runningErrors = Math.max(0, parseInt(fields.errors, 10) || 0);
    const runningNotes = Math.max(0, parseInt(fields.notesCreated, 10) || 0);

    // The identifier column must be mapped. Validate before we create a job
    // record so we never leave a dangling "running" row.
    const identifierMapping = mappings.find(m => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
    }

    const { records, isXlsx } = await parseImportFile(file);
    console.log(`[Import] Parsed ${records.length} rows (${isXlsx ? 'xlsx' : 'csv'}), resuming from offset ${offset}`);

    // Record this run up-front (first chunk only) so it appears in the "Recent
    // Imports" panel and its mapping can be reused later. Later chunks reuse the
    // same job id so there is exactly one job row per import.
    if (incomingJobId) {
      jobId = incomingJobId;
    } else {
      jobId = await startImportJob({
        tenantId: importTenantId,
        entityType,
        fileName: file.originalname || 'import.csv',
        totalRows: records.length,
        mappings,
        identifierField,
      });
      // Fail loudly if we could not create the job row on the first chunk.
      // Returning a null jobId here would make every subsequent chunk create
      // its OWN job row (no incomingJobId to reuse) — many duplicate "running"
      // rows for one import. Abort before processing any data instead.
      if (!jobId) {
        return res.status(500).json({
          error: 'Could not start the import (failed to create its job record). Please try again.',
          jobCreationFailed: true,
        });
      }
    }

    const result = await processImportSlice({
      supabase,
      records,
      offset,
      mappings,
      entityType,
      identifierField,
      tenantId: importTenantId,
      authorMemberId: session.data.memberId,
      forceJsPath,
      running: {
        created: runningCreated,
        updated: runningUpdated,
        skipped: runningSkipped,
        errors: runningErrors,
        notes: runningNotes,
      },
      timeBudgetMs: CHUNK_TIME_BUDGET_MS,
    });

    await updateImportJobProgress(jobId, {
      created: result.created,
      updated: result.updated,
      errors: result.errors,
      newErrors: result.errorLog,
      done: result.done,
    });

    return res.json({
      success: true,
      done: result.done,
      jobId,
      path: result.path,
      offset: result.done ? records.length : result.offset,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors,
      notesCreated: result.notes,
      totalRows: records.length,
      summary: result.summary,
      errorDetails: (result.errorLog || []).slice(0, 20),
    });
  } catch (error) {
    console.error('[Import Execute] Error:', error);
    // Don't leave a half-finished run stuck on "running" in the history panel.
    if (jobId) {
      try {
        await supabase
          .from('csv_import_job')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', jobId);
      } catch (e) {
        console.log('[Import] Could not mark job failed:', e.message);
      }
    }
    res.status(500).json({ error: error.message || 'Failed to execute import' });
  }
}
