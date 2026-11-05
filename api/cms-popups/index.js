import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { setMemberContentCacheHeaders } from '../_lib/canvasMemberOnly.js';
import { eligiblePopups, popupQuery, popupRuntimeRecord, popupTimezone, resolvePopupDesign } from '../_lib/cmsPopupService.js';
import { isPopupId } from '../../shared/cmsPopupContract.js';

export function createPopupDeliveryHandler({ db = supabase, resolveTenant = resolveTenantFromRequest, contextFor = getTenantContext } = {}) {
  return async function handler(req, res) {
    setMemberContentCacheHeaders(res, { includeHost: true });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      if (!db) return res.status(503).json({ error: 'Database unavailable' });
      const input = req.method === 'POST' ? req.body || {} : req.query || {};
      // Slug discovery may overlap page-content loading. Content and preference
      // requests still require the resolved page ID and fresh authorization.
      const slugDiscovery = req.method === 'GET' && !input.id && input.page_id === undefined
        && typeof input.page_slug === 'string' && input.page_slug.length > 0
        && input.page_slug.length <= 200 && !/[/?#\s]/.test(input.page_slug);
      if ((!isPopupId(input.page_id) && !slugDiscovery) || (input.id && !isPopupId(input.id))) return res.status(400).json({ error: 'Invalid page or popup identifier' });
      const [tenant, context] = await Promise.all([resolveTenant(req), contextFor(req)]);
      if (!tenant || tenant.status !== 'active') return res.status(404).json({ error: 'Page unavailable' });
      // Never downgrade an authenticated non-member or mismatched identity to guest.
      if (context.tenantMismatch || (context.isAuthenticated && context.tenantId !== tenant.id)) return res.status(403).json({ error: 'Viewer context changed' });
      const viewer = { isAuthenticated: context.isAuthenticated === true,
        memberId: context.isAuthenticated ? context.memberId || null : null };
      let pageQuery = db.from('i_edit_page').select('id,tenant_id,status,layout_type,microsite_id')
        .eq('tenant_id', tenant.id).eq(slugDiscovery ? 'slug' : 'id', slugDiscovery ? input.page_slug : input.page_id).eq('status', 'published');
      pageQuery = input.microsite_id ? pageQuery.eq('microsite_id', input.microsite_id) : pageQuery.is('microsite_id', null);
      const page = await popupQuery(pageQuery.maybeSingle());
      if (!page || (page.microsite_id || null) !== (input.microsite_id || null)
        || !['public', 'hybrid', 'member', 'public_no_chrome', 'public_header_only', 'public_footer_only'].includes(page.layout_type)
        || (page.layout_type === 'member' && !viewer.memberId)) return res.status(404).json({ error: 'Page unavailable' });
      if (page.microsite_id) {
        const site = await popupQuery(db.from('microsite').select('id').eq('tenant_id', tenant.id).eq('id', page.microsite_id).eq('is_active', true).maybeSingle());
        if (!site) return res.status(404).json({ error: 'Page unavailable' });
      }
      const base = { tenant_id: tenant.id, page_id: page.id, viewer_key: viewer.memberId ? `member:${viewer.memberId}` : viewer.isAuthenticated ? `account:${context.tenantUserId}` : 'guest',
        timezone: popupTimezone(tenant) };
      // Revalidation and preference writes must still work after the shown
      // event has advanced daily frequency state.
      const ignoreFrequency = req.method === 'POST' || input.revalidate === '1';
      const eligible = await eligiblePopups(db, tenant, page, viewer, { id: input.id || null, ignoreFrequency,
        allowPermanentReplay: req.method === 'POST' && input.action === 'permanent' });
      if (req.method === 'GET' && !input.id) {
        return res.json({ ...base, candidates: eligible.map(({ popup, state }) => popupRuntimeRecord(popup, state)) });
      }
      const selected = eligible.find(e => e.popup.id === input.id);
      if (!selected) return res.status(404).json({ error: 'Popup unavailable' });
      const { popup, state } = selected;
      if (Number(input.revision) !== popup.revision) return res.status(409).json({ error: 'Popup changed' });
      if (req.method === 'POST') {
        if (!viewer.memberId) return res.status(401).json({ error: 'Member preference requires sign in' });
        if (!['shown', 'permanent'].includes(input.action) || Number(input.generation) !== popup.dismissal_generation
          || (input.action === 'permanent' && !popup.config.allow_permanent)) return res.status(400).json({ error: 'Preference unavailable' });
        await popupQuery(db.rpc('cms_popup_preference', {
          p_tenant: tenant.id, p_popup: popup.id, p_member: viewer.memberId, p_generation: popup.dismissal_generation,
          p_revision: popup.revision, p_action: input.action,
          p_shown_at: input.action === 'shown' ? input.shown_at || null : null,
        }));
        return res.json({ success: true });
      }
      return res.json({ ...base, popup: { ...popupRuntimeRecord(popup, state),
        ...await resolvePopupDesign(db, tenant.id, popup, !!viewer.memberId) } });
    } catch (error) {
      console.error('[CMS popup delivery]', error.code || error.message);
      return res.status(error.code === '40001' ? 409 : 503).json({ error: 'Popup eligibility could not be verified.' });
    }
  };
}
export default createPopupDeliveryHandler();
