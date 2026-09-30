import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { listDemoDefinitions } from '../../../demo-seeds/registry.mjs';
import { demoTenantStatus } from '../../../demo-seeds/engine.mjs';

/**
 * GET /api/platform/demo-tenants
 *
 * Lists all registered demo tenant definitions with their current install
 * status (installed/not installed, seed version, last seeded, mapped tenant).
 * Platform-owner only.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Platform owner authentication required' });
  }

  try {
    const definitions = await Promise.all(
      listDemoDefinitions().map(async (def) => {
        const status = await demoTenantStatus(def, { sb: supabase });
        return {
          key: def.key,
          name: def.tenant.name,
          slug: def.tenant.slug,
          version: def.version,
          defaultSize: def.defaultSize || 'small',
          loginPersonas: typeof def.loginPersonas === 'function' ? def.loginPersonas() : [],
          status,
        };
      })
    );
    return res.status(200).json({ definitions });
  } catch (error) {
    console.error('[Platform Demo Tenants] list failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to list demo tenants' });
  }
}
