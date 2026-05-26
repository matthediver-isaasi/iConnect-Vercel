/**
 * /api/admin/onboarding
 *
 *   GET    → current onboarding state for the caller's tenant
 *   PATCH  → merge partial wizard state into tenant.onboarding_data
 *   POST   → finish: run the seeder, mark onboarding_status='complete'
 *
 * Tenant context is required (hard-fail otherwise) — strict tenant isolation.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { runOnboardingSeeder } from '../_lib/onboardingSeeder.js';
import { isValidPersona } from '../_lib/personaSeedPacks.js';

async function loadTenant(tenantId) {
  const { data, error } = await supabase
    .from('tenant')
    .select('id, name, slug, plan_code, onboarding_status, onboarding_data, onboarding_completed_at')
    .eq('id', tenantId)
    .single();
  if (error) return null;
  return data;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId || !ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const tenantId = ctx.tenantId;

  if (req.method === 'GET') {
    const tenant = await loadTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    return res.status(200).json({ tenant });
  }

  if (req.method === 'PATCH') {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    if (patch.persona && !isValidPersona(patch.persona)) {
      return res.status(400).json({ error: 'Invalid persona' });
    }
    const tenant = await loadTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const merged = { ...(tenant.onboarding_data || {}), ...patch };
    const { error } = await supabase
      .from('tenant')
      .update({ onboarding_data: merged })
      .eq('id', tenantId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, onboarding_data: merged });
  }

  if (req.method === 'POST') {
    const tenant = await loadTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const payload = { ...(tenant.onboarding_data || {}), ...(req.body || {}) };
    if (payload.persona && !isValidPersona(payload.persona)) {
      return res.status(400).json({ error: 'Invalid persona' });
    }

    const seedResult = await runOnboardingSeeder(tenantId, payload);

    const { error: completeError } = await supabase
      .from('tenant')
      .update({
        onboarding_status: 'complete',
        onboarding_completed_at: new Date().toISOString(),
        onboarding_data: payload,
      })
      .eq('id', tenantId);
    if (completeError) return res.status(500).json({ error: completeError.message });

    return res.status(200).json({ ok: true, seed: seedResult });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
