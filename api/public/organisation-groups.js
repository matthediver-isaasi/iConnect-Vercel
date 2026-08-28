import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { loadFormOrganisationGroupOptions } from '../_lib/formOrganisationGroups.js';

export async function organisationGroupsHandler(req, res, dependencies = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = dependencies.db || (() => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  })();
  if (!db) return res.status(503).json({ error: 'Supabase not configured' });

  const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
  if (!tenant?.id) return res.status(400).json({ error: 'Invalid tenant context' });

  const { formId, formSlug, fieldId } = req.body || {};
  if ((!formId && !formSlug) || !fieldId) return res.status(400).json({ error: 'Form and field are required' });

  const groups = await loadFormOrganisationGroupOptions({
    db,
    tenantId: tenant.id,
    formId,
    formSlug,
    fieldId,
  });
  return res.json(groups);
}

export default function handler(req, res) {
  return organisationGroupsHandler(req, res);
}