import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { orderedIds } = req.body;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: 'orderedIds array is required' });
  }

  try {
    const { data: actions, error: fetchError } = await supabase
      .from('stage_member_action')
      .select('id, due_diligence_stage_id')
      .in('id', orderedIds)
      .eq('tenant_id', tenantCtx.tenantId);

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!actions || actions.length !== orderedIds.length) {
      return res.status(400).json({ error: 'Some action IDs are invalid or do not belong to this tenant' });
    }

    const stageIds = new Set(actions.map(a => a.due_diligence_stage_id));
    if (stageIds.size > 1) {
      return res.status(400).json({ error: 'All actions must belong to the same stage' });
    }

    const updates = orderedIds.map((id, index) =>
      supabase
        .from('stage_member_action')
        .update({ sort_order: index })
        .eq('id', id)
        .eq('tenant_id', tenantCtx.tenantId)
    );

    await Promise.all(updates);

    return res.json({ success: true });
  } catch (error) {
    console.error('[stage-member-actions/reorder] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
