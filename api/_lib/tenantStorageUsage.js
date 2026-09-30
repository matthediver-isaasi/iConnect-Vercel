/**
 * Tenant cumulative storage usage (Task #1027)
 *
 * Maintains the `tenant.storage_used_bytes` counter that powers
 * `checkStorageQuota` in `api/_lib/planQuota.js` and the storage row on the
 * admin "Plan & usage" page. Upload endpoints call `addTenantStorageBytes`
 * after a successful upload with the file size; delete endpoints call it
 * with a negative delta after a successful delete.
 *
 * Best-effort: failures are logged but never thrown — a counter drift is
 * preferable to failing the user's upload, and `scripts/recompute-tenant-
 * storage.mjs` can re-baseline by summing the actual objects in Supabase
 * Storage.
 */

import { supabase } from './database.js';

export async function addTenantStorageBytes(tenantId, deltaBytes) {
  if (!tenantId || !supabase) return null;
  const delta = Number(deltaBytes);
  if (!Number.isFinite(delta) || delta === 0) return null;

  try {
    const { data, error } = await supabase.rpc('increment_tenant_storage_bytes', {
      p_tenant_id: tenantId,
      p_delta: Math.trunc(delta),
    });
    if (error) {
      console.error('[tenantStorageUsage] RPC failed:', error.message || error);
      return null;
    }
    return typeof data === 'number' ? data : (data == null ? null : Number(data));
  } catch (err) {
    console.error('[tenantStorageUsage] RPC threw:', err?.message || err);
    return null;
  }
}

export async function getTenantStorageBytes(tenantId) {
  if (!tenantId || !supabase) return 0;
  try {
    const { data } = await supabase
      .from('tenant')
      .select('storage_used_bytes')
      .eq('id', tenantId)
      .single();
    const n = Number(data?.storage_used_bytes || 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
