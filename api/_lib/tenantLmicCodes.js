/**
 * Tenant LMIC country-code loading with lazy seed (Task #3477).
 *
 * Extracted from api/dashboard/_lib/aggregation.js so the form submission
 * processors (submit-control enforcement) and the public form endpoint use
 * the exact same loading semantics as the dashboard LMIC filters:
 *
 *  - Saved rows in tenant_lmic_country win.
 *  - No rows + no tenant_lmic_seed marker → lazily seed the World Bank
 *    defaults (first-touch tenants get a sensible list).
 *  - No rows + seed marker present → the admin intentionally saved an empty
 *    list; return [] (LMIC operators then match nothing).
 *
 * Accepts the caller's supabase client so it works with both the shared
 * api/_lib/database.js client and locally-created service clients.
 *
 * Callers that would treat [] as an authoritative destructive update must pass
 * `{ strict: true }`. Strict mode throws unless an empty list is confirmed by
 * the tenant's seed marker.
 */
import { WORLD_BANK_LMIC_ISO2 } from '../../shared/lmicCountries.js';

export async function loadTenantLmicCodes(supabase, tenantId, options = {}) {
  const strict = options?.strict === true;
  let q = supabase.from('tenant_lmic_country').select('country_code');
  q = tenantId ? q.eq('tenant_id', tenantId) : q.is('tenant_id', null);
  const { data, error } = await q;
  if (error) {
    console.error('[LMIC] Failed to load LMIC codes:', error.message);
    if (strict) {
      throw new Error(`Failed to load tenant LMIC codes: ${error.message}`, { cause: error });
    }
    return [];
  }
  const codes = (data || []).map(r => String(r.country_code || '').toUpperCase()).filter(Boolean);
  if (codes.length > 0 || !tenantId) return codes;
  // No rows: distinguish "never initialised" from "admin saved empty list"
  // via the tenant_lmic_seed marker. Only the never-initialised case
  // triggers a lazy seed of the World Bank defaults.
  const { data: seedRow, error: seedErr } = await supabase
    .from('tenant_lmic_seed')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (seedErr) {
    console.warn('[LMIC] seed marker lookup warning:', seedErr.message);
    if (strict) {
      throw new Error(`Failed to confirm tenant LMIC seed state: ${seedErr.message}`, { cause: seedErr });
    }
  }
  if (seedRow) return [];
  try {
    const rows = WORLD_BANK_LMIC_ISO2.map(code => ({ tenant_id: tenantId, country_code: code }));
    const { error: insertErr } = await supabase
      .from('tenant_lmic_country')
      .insert(rows);
    if (insertErr) {
      // Most likely a race with another request that just seeded the
      // same tenant — re-read and use whatever is now there.
      console.warn('[LMIC] seed insert warning:', insertErr.message);
      const { data: after, error: afterErr } = await supabase
        .from('tenant_lmic_country')
        .select('country_code')
        .eq('tenant_id', tenantId);
      if (afterErr) {
        if (strict) {
          throw new Error(`Failed to re-read tenant LMIC codes: ${afterErr.message}`, { cause: afterErr });
        }
        return [];
      }
      const afterCodes = (after || [])
        .map(r => String(r.country_code || '').toUpperCase())
        .filter(Boolean);
      if (afterCodes.length > 0) return afterCodes;
      if (strict) {
        const { data: afterSeedRow, error: afterSeedErr } = await supabase
          .from('tenant_lmic_seed')
          .select('tenant_id')
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (afterSeedErr) {
          throw new Error(
            `Failed to confirm tenant LMIC seed state after insert failure: ${afterSeedErr.message}`,
            { cause: afterSeedErr }
          );
        }
        if (afterSeedRow) return [];
        throw new Error(`Failed to seed tenant LMIC codes: ${insertErr.message}`, { cause: insertErr });
      }
      return [];
    }
    const { error: markErr } = await supabase
      .from('tenant_lmic_seed')
      .upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id' });
    if (markErr) {
      console.warn('[LMIC] seed marker upsert warning:', markErr.message);
    }
    return [...WORLD_BANK_LMIC_ISO2];
  } catch (err) {
    console.error('[LMIC] seed failed:', err.message || err);
    if (strict) throw err;
    return [];
  }
}
