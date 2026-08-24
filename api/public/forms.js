import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveFormAccess } from '../_lib/formAccessPolicy.js';
import { getSession, getSessionMember } from '../_lib/session.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';

const PUBLIC_FORM_FIELDS = [
  'id', 'name', 'slug', 'description', 'is_active', 
  'layout_type', 'submit_button_text', 'success_message',
  'require_authentication'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: forms, error } = await supabase
      .from('form')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public Forms] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch forms' });
    }

    const availableForms = (forms || []).filter((form) => isFormScheduleAvailable(form));
    const hasRestrictions = availableForms.some((form) => (
      (form.access_policy?.group_rules?.length || 0) > 0
      || (form.access_policy?.rbac_role_ids?.length || 0) > 0
    ));
    let session = null;
    let member = null;
    if (hasRestrictions) {
      session = await getSession(req);
      if (session) member = await getSessionMember(req);
    }
    const publicForms = (await Promise.all(availableForms.map(async form => {
      const access = await resolveFormAccess({
        supabase, req, tenantId: tenant.id, policy: form.access_policy, session, member,
      });
      // A list response must not disclose even a partial record for a form the
      // viewer cannot open. Eligible restricted forms remain visible.
      if (!access.allowed) return null;
      const publicForm = {};
      for (const field of PUBLIC_FORM_FIELDS) {
        if (form[field] !== undefined) {
          publicForm[field] = form[field];
        }
      }
      publicForm.access_policy_required = access.restricted;
      publicForm.access = access;
      return publicForm;
    }))).filter(Boolean);

    return res.status(200).json(publicForms);
  } catch (error) {
    console.error('[Public Forms] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
