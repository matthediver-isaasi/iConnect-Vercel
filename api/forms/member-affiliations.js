import { supabase } from '../_lib/database.js';
import { getSession, getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { resolveFormAccess } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { assertAffiliationFormCompatibility } from '../_lib/formMemberAffiliationConfig.js';
import { memberAffiliationPrefill } from '../_lib/formMemberAffiliations.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const db = deps.db || supabase;
    const context = await (deps.getTenantContext || getTenantContext)(req);
    const tenantId = context?.effectiveTenantId || context?.tenantId;
    const session = await (deps.getSession || getSession)(req);
    const member = await (deps.getSessionMember || getSessionMember)(req);
    if (!tenantId || !session || !member?.id || (member.tenant_id || member.organization?.tenant_id) !== tenantId
      || session.data?.memberId !== member.id) return res.status(403).json({ error: 'Sign in with your member account to load your affiliations.' });
    const { data: form, error } = await db.from('form').select('*').eq('tenant_id', tenantId)
      .eq('id', req.query?.form_id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!form || !isFormScheduleAvailable(form)) return res.status(404).json({ error: 'Form unavailable' });
    const access = await (deps.resolveFormAccess || resolveFormAccess)({
      supabase: db, req, tenantId, policy: form.access_policy, member, session,
    });
    if (!access.allowed) return res.status(403).json({ error: 'This form is not available to your account.' });
    if (form.member_affiliation_enabled !== true) return res.status(200).json({ active: false });
    assertAffiliationFormCompatibility(form);
    const { data: captured, error: captureError } = await db.rpc('form_member_affiliation_capture', {
      p_tenant: tenantId, p_form: form.id, p_member: member.id,
    });
    if (captureError || !captured?.token || !captured?.graph || !captured?.config) throw new Error('Snapshot unavailable');
    const prefill = memberAffiliationPrefill({ ...captured, member_id: member.id });
    return res.status(200).json({ active: true, snapshotToken: captured.token, ...prefill });
  } catch {
    return res.status(503).json({ error: 'Your current affiliations could not be loaded. Retry before submitting this form.' });
  }
}
