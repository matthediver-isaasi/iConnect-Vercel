import { supabase } from './_lib/database.js';
import { getSession, getSessionMember } from './_lib/session.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { loadProfilePolicy, validateLiveProfilePolicy, projectProfileAffiliations } from './_lib/profileAffiliations.js';
import { normalizeProfileAffiliationRequest } from './_lib/profileAffiliationPolicy.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const db = deps.db || supabase;
    const context = await (deps.getTenantContext || getTenantContext)(req);
    const tenantId = context?.effectiveTenantId || context?.tenantId;
    const session = await (deps.getSession || getSession)(req);
    const member = await (deps.getSessionMember || getSessionMember)(req);
    if (context?.tenantMismatch || !tenantId || !session || !member?.id
      || session.data?.memberId !== member.id || (member.tenant_id || member.organization?.tenant_id) !== tenantId) {
      return res.status(403).json({ error: 'Sign in with your member account to edit affiliations.' });
    }
    const policy = await loadProfilePolicy(db, tenantId);
    if (policy.config.enabled !== true) return req.method === 'GET'
      ? res.json({ active: false }) : res.status(403).json({ error: 'Member affiliation editing is disabled.' });
    const metadata = await (deps.validatePolicy || validateLiveProfilePolicy)(db, tenantId, member, policy);
    if (req.method === 'GET') {
      const { data, error } = await db.rpc('profile_affiliation_capture', { p_tenant: tenantId, p_member: member.id });
      if (error) throw error;
      if (!data.active) return res.json({ active: false });
      return res.json(await projectProfileAffiliations(db, tenantId, member.id, data, metadata));
    }
    if (req.method === 'PATCH') {
      let proposal;
      try { proposal = normalizeProfileAffiliationRequest(req.body); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const { data, error } = await db.rpc('profile_affiliation_apply', {
        p_tenant: tenantId, p_member: member.id, p_token: req.body.token, p_request: proposal,
      });
      if (error) throw error;
      if (data?.committed !== true) throw new Error('Unconfirmed save');
      return res.json(data);
    }
    const body = req.body;
    if (body?.action !== 'choices' || !['organization', 'department'].includes(body.kind)
      || typeof body.search !== 'string' || body.search.length > 100
      || !Number.isSafeInteger(body.page) || body.page < 1 || body.page > 10000) {
      return res.status(400).json({ error: 'Invalid choice search.' });
    }
    let proposal;
    try { proposal = normalizeProfileAffiliationRequest({ token: body.token, primary: body.primary, secondary: body.secondary }); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const { data, error } = await db.rpc('profile_affiliation_choices', {
      p_tenant: tenantId, p_member: member.id, p_token: body.token, p_kind: body.kind,
      p_search: body.search, p_page: body.page, p_primary: proposal.primary, p_secondary: proposal.secondary,
    });
    if (error) throw error;
    return res.json(data);
  } catch (error) {
    const status = error.status || (error.code === '40001' || error.code === '23505' ? 409
      : error.code === '42501' ? 403 : ['22023', '23514', 'P0001'].includes(error.code) ? 422 : 503);
    return res.status(status).json({ error: [403, 409, 422].includes(status)
      ? error.message : 'Affiliations could not be confirmed. Your draft is retained; retry or contact an administrator.' });
  }
}
