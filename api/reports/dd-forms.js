import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    const { tenantId } = tenantContext;

    const { data: configs, error: cfgErr } = await supabase
      .from('form_due_diligence_config')
      .select('form_id')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    if (cfgErr) return res.status(500).json({ error: 'Failed to fetch configs' });

    const formIds = (configs || []).map((c) => c.form_id);
    if (formIds.length === 0) return res.status(200).json([]);

    const { data: forms, error: formErr } = await supabase
      .from('form')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', formIds);
    if (formErr) return res.status(500).json({ error: 'Failed to fetch forms' });

    const list = (forms || [])
      .map((f) => ({ form_id: f.id, form_name: f.name }))
      .sort((a, b) => a.form_name.localeCompare(b.form_name));
    return res.status(200).json(list);
  } catch (e) {
    console.error('[dd-forms] error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
