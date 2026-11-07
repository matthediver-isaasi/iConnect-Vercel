import { supabase } from '../_lib/database.js';
import { getSession, getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { resolveFormAccess } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { assertAffiliationFormCompatibility } from '../_lib/formMemberAffiliationConfig.js';
import { memberAffiliationPrefill } from '../_lib/formMemberAffiliations.js';
import { assertProfileFormRoute } from '../_lib/profileAffiliationForms.js';
import { normalizeOrganizationPreferenceValue } from '../_lib/organizationEligibility.js';
import { getCountryByCode, resolveCountryToIso2 } from '../../shared/countries.js';

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
    const { data: configRow, error: configError } = await db.from('form_member_affiliation_config').select('config')
      .eq('tenant_id', tenantId).eq('form_id', form.id).maybeSingle();
    if (configError) throw configError;
    const profile = configRow?.config?.purpose === 'profile';
    const route = profile ? await assertProfileFormRoute(db, tenantId, member.id, form.id) : null;
    const { data: captured, error: captureError } = await db.rpc(profile ? 'profile_form_affiliation_capture' : 'form_member_affiliation_capture', {
      p_tenant: tenantId, p_form: form.id, p_member: member.id,
      ...(profile ? { p_version: route.policy.version } : {}),
    });
    if (captureError || !captured?.token || !captured?.graph || !captured?.config) throw new Error('Snapshot unavailable');
    if (!profile && captured.config.prefillAffiliationQuestions === true) {
      let organization = null;
      if (captured.graph.organization_id) {
        const result = await db.from('organization').select('organization_group_id')
          .eq('tenant_id', tenantId).eq('id', captured.graph.organization_id).single();
        if (result.error || !result.data) throw new Error('Organisation unavailable');
        organization = result.data;
      }
      captured.profile_group_id = member.organization_group_id || organization?.organization_group_id || '';
    }
    if ((profile || captured.config.prefillAffiliationQuestions === true)
      && captured.graph.organization_id && captured.config.organizationCountryFieldId) {
      const { data: country, error } = await db.from('organization_preference_value').select('value')
        .eq('organization_id', captured.graph.organization_id).eq('field_id', captured.config.organizationCountryFieldId).maybeSingle();
      if (error) throw error;
      const value = normalizeOrganizationPreferenceValue(country?.value);
      captured.profile_country = getCountryByCode(resolveCountryToIso2(value))?.name || value || '';
    }
    const prefill = memberAffiliationPrefill({ ...captured, member_id: member.id });
    return res.status(200).json({ active: true, snapshotToken: captured.token, ...prefill });
  } catch {
    return res.status(503).json({ error: 'Your current affiliations could not be loaded. Retry before submitting this form.' });
  }
}
