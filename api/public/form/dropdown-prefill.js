import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import {
  FormDropdownPrefillError,
  resolveFormDropdownPrefill,
} from '../../_lib/formDropdownPrefill.js';

export async function dropdownPrefillHandler(req, res, dependencies = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const db = dependencies.db || (
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      : null
  );
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
    if (!tenant?.id) return res.status(400).json({ error: 'Invalid tenant context' });
    const {
      formId, formSlug, sourceFieldId, recordId, selectedRecordId, sourceAnswers,
    } = req.body || {};
    const result = await resolveFormDropdownPrefill({
      db,
      req,
      tenantId: tenant.id,
      formId,
      formSlug,
      requestedSourceFieldId: sourceFieldId,
      recordId: recordId || selectedRecordId,
      sourceAnswers,
      resolveAccess: dependencies.resolveAccess,
      resolveSession: dependencies.resolveSession,
      now: dependencies.now,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof FormDropdownPrefillError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[Public Dropdown Prefill] Error:', error);
    return res.status(500).json({ error: 'Failed to resolve dropdown prefill' });
  }
}

export default function handler(req, res) {
  return dropdownPrefillHandler(req, res);
}