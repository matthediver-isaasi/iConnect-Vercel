import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { loadTenantAiAssistantConfig } from '../_lib/tenantAiAssistant.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!ctx.tenantId) return res.status(400).json({ error: 'Tenant context required' });
    return res.status(200).json(await loadTenantAiAssistantConfig(ctx.tenantId));
  } catch (error) {
    console.error('[Member AI Config] Error:', error);
    return res.status(503).json({ error: 'Assistant settings are unavailable.' });
  }
}