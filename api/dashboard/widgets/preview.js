import { getDashboardActor } from '../_lib/permissions.js';
import { runWidgetConfig } from '../_lib/aggregation.js';
import { widgetConfigSchema } from '../_lib/validation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const actor = await getDashboardActor(req);
  if (!actor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!actor.permissions.view) {
    return res.status(403).json({ error: 'Dashboard not available for this role' });
  }

  const parsed = widgetConfigSchema.safeParse(req.body?.config);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid widget config', details: parsed.error.flatten() });
  }

  try {
    const result = await runWidgetConfig(parsed.data, actor.tenantId);
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('[Dashboard Widgets] Preview failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to run preview' });
  }
}
