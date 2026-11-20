import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  DEPARTMENT_CURRENT_SET_FORM_ID,
  DEPARTMENT_CURRENT_SET_TENANT_ID,
} from '../../_lib/departmentCurrentSet.js';

// Editor capability only: never return the reconciliation/relationship mappings
// or infer authority from the form's labels, fields or browser-supplied flags.
export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (context?.tenantMismatch) {
      return res.status(409).json({ code: 'TENANT_CONTEXT_CHANGED', error: 'Reload this tab to continue in the current organisation.' });
    }
    if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!context.tenantId || !await (dependencies.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const formId = req.query.formId;
    if (typeof formId !== 'string' || !/^[0-9a-f-]{36}$/i.test(formId)) {
      return res.status(400).json({ error: 'A form ID is required' });
    }
    const db = dependencies.db || supabase;
    if (!db) throw new Error('Database unavailable');
    const { data: form, error: formError } = await db.from('form').select('id')
      .eq('tenant_id', context.tenantId).eq('id', formId).maybeSingle();
    if (formError) throw new Error('Form lookup unavailable');
    if (!form) return res.status(404).json({ error: 'Form not found' });

    let enabled = false;
    if (context.tenantId === DEPARTMENT_CURRENT_SET_TENANT_ID && formId === DEPARTMENT_CURRENT_SET_FORM_ID) {
      const { data, error } = await db.from('department_current_set_config').select('config')
        .eq('tenant_id', context.tenantId).eq('form_id', formId).maybeSingle();
      // A missing optional table/column in an older schema is unavailability,
      // not evidence that this configured workflow has been disabled.
      if (error) throw new Error('Configuration lookup unavailable');
      if (data) {
        const config = data.config;
        const workforce = config?.workforce_container_field_id || config?.workforce_field_id;
        const equipment = config?.equipment_container_field_id || config?.equipment_field_id;
        if (!config || Array.isArray(config) || typeof workforce !== 'string' || !workforce.trim()
          || typeof equipment !== 'string' || !equipment.trim()) {
          throw new Error('Configuration invalid');
        }
        enabled = true;
      }
    }
    return res.status(200).json({ form_id: formId, current_set_enabled: enabled });
  } catch {
    return res.status(503).json({ error: 'Form editor configuration is temporarily unavailable. Retry before editing.' });
  }
}
