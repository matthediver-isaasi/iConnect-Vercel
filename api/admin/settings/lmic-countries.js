/**
 * Admin LMIC country list endpoint (task #607)
 *
 * GET    -> returns the saved list. If a tenant has never had a list saved
 *           (no rows in tenant_lmic_country) the World Bank LMIC seed is
 *           inserted on first read so the page never loads with an empty
 *           selector for a brand-new tenant.
 *
 * PUT    -> replaces the saved list. Body: { codes: ['KE', 'IN', ...] }.
 *           A delete-then-insert is intentional: the table is small (a few
 *           hundred rows per tenant, max) and a clean replace removes any
 *           ambiguity around partial updates.
 *
 * POST   -> action=reset. Replaces the saved list with the World Bank
 *           default. Useful when an admin has tinkered themselves into a
 *           confusing state and wants to start over.
 */

import { getSessionTenantUser } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';
import {
  WORLD_BANK_LMIC_ISO2,
  normaliseCountryCodes,
} from '../../../shared/lmicCountries.js';

const LMIC_RESOURCE_ID = 'system.lmic-countries';

async function getRoleExcludedFeatures(roleId) {
  if (!roleId || !supabase) return [];
  try {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    return role?.excluded_features || [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) return res.status(401).json({ error: 'Unauthorized' });
  const tenantId = tenantUser.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });

  // Authorisation gate has two layers, mirroring the pattern used by
  // other admin settings endpoints (e.g. article-briefs/settings.js):
  //   1) Coarse: tenant owners/admins only — non-admin members cannot
  //      reach this endpoint regardless of role configuration.
  //   2) Fine-grained: even admins are denied if their tenant role has
  //      explicitly excluded the `system.lmic-countries` resource via
  //      the role-access UI (resource id registered in roleAccessMap.ts).
  // The exclusion check is enforced server-side rather than relying on
  // UI hiding, so a denied admin cannot bypass via direct API calls.
  const role = tenantUser.role;
  const isAdmin = role === 'owner' || role === 'admin';
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin role required for LMIC settings' });
  }
  // Pull the active role's excluded_features via tenant context — this is
  // the same source the frontend uses, so admin/portal exclusions stay in
  // sync with what the role configuration UI shows.
  const ctx = await getTenantContext(req);
  const excluded = await getRoleExcludedFeatures(ctx?.roleId);
  if (isResourceExcluded(excluded, LMIC_RESOURCE_ID)) {
    return res.status(403).json({ error: 'Access to LMIC settings has been disabled for your role' });
  }

  try {
    if (req.method === 'GET') {
      const codes = await loadCodes(tenantId);
      const seeded = await isSeeded(tenantId);
      if (codes.length === 0 && !seeded) {
        // First-ever read for this tenant: seed defaults so the picker
        // isn't empty out of the box. Subsequent saves (including saves
        // of an empty list) flip the seed marker so we never silently
        // re-seed over an admin's intentional clear.
        await replaceCodes(tenantId, WORLD_BANK_LMIC_ISO2);
        await markSeeded(tenantId);
        return res.json({ codes: [...WORLD_BANK_LMIC_ISO2], seeded: true });
      }
      return res.json({ codes, seeded: false });
    }

    if (req.method === 'PUT') {
      const codes = normaliseCountryCodes(req.body?.codes);
      await replaceCodes(tenantId, codes);
      // Flag the tenant as initialised even when an empty list is saved
      // so a future read does not re-seed the World Bank defaults.
      await markSeeded(tenantId);
      return res.json({ codes, success: true });
    }

    if (req.method === 'POST') {
      const action = (req.query?.action || req.body?.action || '').toString();
      if (action !== 'reset') {
        return res.status(400).json({ error: 'Unknown action' });
      }
      await replaceCodes(tenantId, WORLD_BANK_LMIC_ISO2);
      await markSeeded(tenantId);
      return res.json({ codes: [...WORLD_BANK_LMIC_ISO2], success: true, reset: true });
    }

    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Admin LMIC] Failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to handle LMIC settings' });
  }
}

async function isSeeded(tenantId) {
  const { data, error } = await supabase
    .from('tenant_lmic_seed')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    // Not fatal — fall through to "not seeded" on lookup errors so we
    // don't block the admin page on a transient query failure.
    console.warn('[Admin LMIC] seed marker lookup warning:', error.message);
    return false;
  }
  return Boolean(data);
}

async function markSeeded(tenantId) {
  const { error } = await supabase
    .from('tenant_lmic_seed')
    .upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id' });
  if (error) {
    console.warn('[Admin LMIC] seed marker upsert warning:', error.message);
  }
}

async function loadCodes(tenantId) {
  const { data, error } = await supabase
    .from('tenant_lmic_country')
    .select('country_code')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return (data || []).map(r => r.country_code).sort();
}

async function replaceCodes(tenantId, codes) {
  const sanitised = normaliseCountryCodes(codes);
  // Delete-then-insert: the dataset is small (max a few hundred rows per
  // tenant) and a clean replace avoids ambiguity around partial updates.
  const del = await supabase
    .from('tenant_lmic_country')
    .delete()
    .eq('tenant_id', tenantId);
  if (del.error) throw del.error;
  if (sanitised.length === 0) return;
  const rows = sanitised.map(code => ({ tenant_id: tenantId, country_code: code }));
  const ins = await supabase.from('tenant_lmic_country').insert(rows);
  if (ins.error) throw ins.error;
}
