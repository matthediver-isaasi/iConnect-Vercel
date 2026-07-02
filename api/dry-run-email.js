import { supabase } from './_lib/database.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { dryRunEmail } from './_lib/workflows.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantCtx = await getTenantContext(req);
    if (!tenantCtx?.tenantId || !tenantCtx?.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { action, workflow_id, entity_type, entity_id } = req.body;

    if (!action || !entity_type || !entity_id) {
      return res.status(400).json({ error: 'Missing required fields: action, entity_type, entity_id' });
    }

    if (!workflow_id) {
      return res.status(400).json({ error: 'Missing workflow_id' });
    }

    const { data: workflow } = await supabase
      .from('workflow')
      .select('*')
      .eq('id', workflow_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    let host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!host && process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');

    const result = await dryRunEmail(action, workflow, entity_type, entity_id, baseUrl);

    return res.json(result);
  } catch (error) {
    console.error('[DryRunEmail] Error:', error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}
