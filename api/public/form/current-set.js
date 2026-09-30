import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import {
  DepartmentCurrentSetError,
  loadDepartmentCurrentSet,
  listDepartmentCurrentSetOptions,
} from '../../_lib/departmentCurrentSet.js';

/** Read-only prefill endpoint. Reconciliation is deliberately lifecycle-only. */
export default async function handler(req, res, dependencies = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const db = dependencies.supabase || (
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null
  );
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const tenant = dependencies.tenant || await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ error: 'Tenant not found' });
    if (!req.query.department_id) {
      const departments = await listDepartmentCurrentSetOptions({
        db, req, tenantId: tenant.id, formId: req.query.form_id,
        getMember: dependencies.getSessionMember,
        getActiveSession: dependencies.getActiveSession,
      });
      return res.status(200).json({ departments });
    }
    const currentSet = await loadDepartmentCurrentSet({
      db, req, tenantId: tenant.id, formId: req.query.form_id,
      departmentId: req.query.department_id, getMember: dependencies.getSessionMember,
      getActiveSession: dependencies.getActiveSession,
      includeOrganization: true,
    });
    return res.status(200).json(currentSet);
  } catch (error) {
    if (error instanceof DepartmentCurrentSetError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[DepartmentCurrentSet] load failed:', error?.message);
    return res.status(500).json({ error: 'Current department data could not be loaded' });
  }
}