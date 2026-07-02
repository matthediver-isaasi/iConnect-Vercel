/**
 * DELETE /api/admin/sample-content
 *
 * Wipes every is_sample=true row across the seeded tables for the caller's
 * tenant. Used by the dashboard's "Remove sample content" action.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { removeSampleContent } from '../_lib/onboardingSeeder.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });

  const result = await removeSampleContent(ctx.tenantId);
  return res.status(200).json(result);
}
