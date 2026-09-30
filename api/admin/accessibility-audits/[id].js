import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess, hasAdminAccess } from '../../_lib/tenantContext.js';

const FEATURE_ID = 'admin.accessibility-audits';

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!context.tenantId) {
    res.status(400).json({ error: 'Tenant context not found' });
    return null;
  }
  if (await hasAdminAccess(context)) return context;
  if (!context.roleId) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  const allowed = await hasFeatureAccess(context.roleId, FEATURE_ID);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return context;
}

export default async function handler(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Audit id is required' });

  try {
    if (req.method === 'GET') {
      const { data: audit, error: auditErr } = await supabase
        .from('accessibility_audit')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', context.tenantId)
        .single();
      if (auditErr || !audit) return res.status(404).json({ error: 'Audit not found' });

      const { data: results, error: resErr } = await supabase
        .from('accessibility_audit_result')
        .select('*')
        .eq('audit_id', id)
        .eq('tenant_id', context.tenantId)
        .order('created_at', { ascending: true });
      if (resErr) return res.status(500).json({ error: resErr.message });

      if (req.query.format === 'json' && req.query.download === '1') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="accessibility-audit-${id}.json"`
        );
        return res.status(200).send(JSON.stringify({ audit, results: results || [] }, null, 2));
      }

      return res.json({ data: audit, results: results || [] });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('accessibility_audit')
        .delete()
        .eq('id', id)
        .eq('tenant_id', context.tenantId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[AccessibilityAudit detail] error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
