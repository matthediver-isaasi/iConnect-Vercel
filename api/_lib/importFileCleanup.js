/**
 * Import source-file cleanup (Task #1365)
 *
 * Background imports upload the source CSV/XLSX to tenant-scoped private
 * storage (`private-uploads` at `<tenantId>/imports/<jobId>/<file>`) so the
 * headless worker can re-parse it each slice. Once a job reaches a terminal
 * state the file is dead weight that keeps counting against the tenant's
 * storage quota, so we delete it and decrement the tenant storage counter.
 *
 * Idempotent: clears the job's storage refs after a successful delete so a
 * repeated call (inline finalisation + cron backstop) is a no-op. Best-effort:
 * failures are logged, never thrown — a counter drift is preferable to failing
 * the worker, and `scripts/recompute-tenant-storage.mjs` re-baselines drift.
 */

import { addTenantStorageBytes } from './tenantStorageUsage.js';

const LIST_PAGE_SIZE = 1000;

/**
 * Remove a finished import job's uploaded source file(s) and adjust storage.
 *
 * @param {object} client  A configured @supabase/supabase-js client.
 * @param {object} job     Row with { id, tenant_id, storage_bucket, storage_path }.
 * @returns {Promise<boolean>} true if files were removed, false otherwise.
 */
export async function cleanupImportJobFile(client, job) {
  if (!client || !job?.storage_bucket || !job?.storage_path) return false;

  let bytesRemoved = 0;
  try {
    // Derive the removed size from the live objects so the counter decrement
    // matches what the nightly recompute would observe. The file lives in its
    // own per-job folder, so list that folder and remove everything in it.
    const lastSlash = job.storage_path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? job.storage_path.slice(0, lastSlash) : '';

    const { data: entries, error: listErr } = await client.storage
      .from(job.storage_bucket)
      .list(folder, { limit: LIST_PAGE_SIZE });

    const paths = [];
    if (listErr) {
      // Couldn't enumerate the folder; fall back to the single known path.
      console.warn('[Import Cleanup] list failed, removing known path only:', listErr.message || listErr);
      paths.push(job.storage_path);
    } else {
      for (const entry of entries || []) {
        // Folders have id === null in Supabase storage list output.
        if (!entry || entry.id === null) continue;
        paths.push(folder ? `${folder}/${entry.name}` : entry.name);
        const size = Number(entry?.metadata?.size || 0);
        if (Number.isFinite(size) && size > 0) bytesRemoved += size;
      }
      if (paths.length === 0) paths.push(job.storage_path);
    }

    const { error: rmErr } = await client.storage.from(job.storage_bucket).remove(paths);
    if (rmErr) {
      console.warn('[Import Cleanup] storage remove failed:', rmErr.message || rmErr);
      return false;
    }
  } catch (e) {
    console.warn('[Import Cleanup] storage remove threw:', e?.message || e);
    return false;
  }

  // Clear the refs so we never try to clean (or download) this file again.
  try {
    await client
      .from('csv_import_job')
      .update({
        storage_bucket: null,
        storage_path: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  } catch (e) {
    console.warn('[Import Cleanup] could not clear storage refs:', e?.message || e);
  }

  if (job.tenant_id && bytesRemoved > 0) {
    addTenantStorageBytes(job.tenant_id, -bytesRemoved).catch(() => {});
  }
  return true;
}
