import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getSessionMember, getSessionTenantUser } from '../_lib/session.js';
import { loadAffiliationReview } from '../_lib/formAffiliationReview.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const db = dependencies.db || supabase;
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!context || !await (dependencies.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    const tenantId = context.effectiveTenantId || context.tenantId;
      const actor = await (dependencies.getSessionMember || getSessionMember)(req)
        || await (dependencies.getSessionTenantUser || getSessionTenantUser)(req);
    if (!tenantId || !actor?.id) return res.status(403).json({ error: 'Verified administrator required' });
    const submissionId = req.method === 'GET' ? req.query?.submission_id : req.body?.submission_id;
    if (!uuid(submissionId)) return res.status(400).json({ error: 'A valid review case is required' });
    const { data: review, error } = await db.from('form_member_affiliation_review')
      .select('id,review_form_submission_id').eq('tenant_id', tenantId)
      .eq('due_diligence_submission_id', submissionId).maybeSingle();
    if (error) throw error;
    if (!review) return res.status(req.method === 'GET' ? 200 : 404).json(req.method === 'GET' ? { active: false } : { error: 'Review not found' });
    const { data: dd, error: ddError } = await db.from('form_submission_due_diligence')
      .select('form_submission_id').eq('tenant_id', tenantId).eq('id', submissionId).maybeSingle();
    if (ddError || !dd || dd.form_submission_id !== review.review_form_submission_id) {
      return res.status(409).json({ error: 'Review linkage could not be verified' });
    }
    if (req.method === 'PUT') {
      if (!Number.isInteger(req.body.expectedVersion) || req.body.expectedVersion < 0) {
        return res.status(400).json({ error: 'Reload the review before saving' });
      }
      const { error: saveError } = await db.rpc('save_form_member_affiliation_resolution', {
        p_tenant_id: tenantId, p_review_id: review.id, p_actor: actor.id,
        p_resolution: req.body.resolution, p_expected_version: req.body.expectedVersion,
      });
      if (saveError) return res.status(409).json({ error: 'The resolution could not be saved. Reload and check the selected organisations and departments.' });
    }
    return res.status(200).json(await (dependencies.loadAffiliationReview || loadAffiliationReview)({ db, tenantId, submissionId }));
  } catch {
    return res.status(503).json({ error: 'Affiliation review is unavailable. No approval has been performed. Please retry.' });
  }
}
