import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { readRenewalJourney } from '../_lib/membershipRenewalJourney.js';
import { readJoiningJourney } from '../_lib/membershipJoiningJourney.js';

export function createRenewalJourneyHandler({ db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess, joining = false } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET','PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Sign in required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId || !await isAdmin(context)) return res.status(403).json({ error: 'Administrator access required' });
      if (req.method === 'GET') {
        const settings = await (joining ? readJoiningJourney : readRenewalJourney)(db, context.tenantId);
        const forms = [];
        for (let start = 0; ; start += 500) {
          let query = db.from('form').select('id,name,archived_at,deactivate_at')
            .eq('tenant_id', context.tenantId).eq('is_active', true)
            .or('form_type.is.null,form_type.eq.standard')
            .order('id').range(start, start + 499);
          if (!joining) query = query.eq('require_authentication', true);
          const { data, error } = await query;
          if (error || !Array.isArray(data)) throw new Error('Forms unavailable');
          forms.push(...data.filter(form => !form.archived_at && (!form.deactivate_at
            || (Number.isFinite(Date.parse(form.deactivate_at)) && Date.parse(form.deactivate_at) > Date.now())))
            .map(({ id, name }) => ({ id, name })));
          if (data.length < 500) break;
        }
        return res.json({ settings, forms });
      }
      const { mode, formId, postGraceFormId, expectedRevision } = req.body || {};
      if ((!joining && !['same_schedule','questionnaire'].includes(mode)) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || (formId != null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(formId))
        || (!joining && postGraceFormId != null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(postGraceFormId))
        || (!joining && mode === 'questionnaire' && !formId)) return res.status(400).json({ error: 'Choose a journey and its form.' });
      const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}` : context.memberId ? `member:${context.memberId}` : null;
      if (!actor) return res.status(403).json({ error: 'Audit identity required' });
      const { data, error } = await db.rpc(joining ? 'save_membership_joining_journey' : 'save_membership_renewal_journey', {
        p_tenant_id: context.tenantId, p_actor: actor,
        ...(!joining ? { p_mode: mode,
          ...(Object.prototype.hasOwnProperty.call(req.body, 'postGraceFormId') ? { p_post_grace_form_id: postGraceFormId || null } : {}),
        } : {}),
        p_form_id: joining ? formId || null : mode === 'questionnaire' ? formId : null,
        p_expected_revision: expectedRevision,
      });
      if (error?.code === '40001') return res.status(409).json({ error: 'Settings changed. Reload before saving.' });
      if (error?.code === '22023') return res.status(400).json({ error: error.message });
      if (error) throw error;
      return res.json({ settings: data });
    } catch { return res.status(503).json({ error: 'Membership journey settings could not be loaded or saved. Please retry.' }); }
  };
}
export default createRenewalJourneyHandler();
