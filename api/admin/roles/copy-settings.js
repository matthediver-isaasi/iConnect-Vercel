import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { copyRoleSettings } from '../../_lib/roleSettingsCopy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await copyRoleSettings({
      db: supabase,
      context: await getTenantContext(req),
      sourceRoleId: req.body?.sourceRoleId,
      targetRoleId: req.body?.targetRoleId,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[role-copy-settings] error:', error);
    return res.status(500).json({ error: 'Unable to copy access settings' });
  }
}