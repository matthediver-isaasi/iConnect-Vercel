import { supabase } from '../../_lib/database.js';
import { POPUP_PORTAL_TARGETS } from '../../../shared/popupPortalTargets.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { setMemberContentCacheHeaders } from '../../_lib/canvasMemberOnly.js';
import { allAffiliationRows } from '../../_lib/formAffiliationReview.js';
import { discoverPopupFields } from '../../_lib/cmsPopupAudience.js';
import { popupQuery, popupTimezone, resolvePopupDesign, validatePopupDocument } from '../../_lib/cmsPopupService.js';
import { isPopupId, POPUP_DEFAULT_CONFIG, POPUP_EMPTY_DESIGN } from '../../../shared/cmsPopupContract.js';

export function createPopupAdminHandler({ db = supabase, contextFor = getTenantContext, featureAccess = hasFeatureAccess } = {}) {
  return async function handler(req, res) {
    setMemberContentCacheHeaders(res, { includeHost: true });
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await contextFor(req);
      if (!context.isAuthenticated) return res.status(401).json({ error: 'Sign in required' });
      if (!context.tenantId || context.tenantMismatch) return res.status(403).json({ error: 'Tenant access required' });
      const feature = req.method === 'GET' && !req.query?.id && !req.query?.preview ? 'site-builder.popups' : 'site-builder.popup-editor';
      if (!context.tenantUserId && !await featureAccess(context.roleId, feature, context.memberExcludedFeatures)) {
        return res.status(403).json({ error: 'Popup permission required' });
      }
      if (!db) return res.status(503).json({ error: 'Database unavailable' });
      const tenantId = context.tenantId;
      const id = req.query?.id;
      if (id && !isPopupId(id)) return res.status(400).json({ error: 'Invalid popup identifier' });
      if (req.method === 'GET' && req.query?.discovery === '1') {
        const [pages, microsites, fields, tenant] = await Promise.all([
          allAffiliationRows(() => db.from('i_edit_page').select('id,title,status,microsite_id', { count: 'exact' }).eq('tenant_id', tenantId)),
          allAffiliationRows(() => db.from('microsite').select('id,name,is_active', { count: 'exact' }).eq('tenant_id', tenantId)),
          discoverPopupFields(db, tenantId, { choices: true }),
          popupQuery(db.from('tenant').select('settings').eq('id', tenantId).single()),
        ]);
        return res.json({ pages, portal_pages: POPUP_PORTAL_TARGETS, microsites, fields, timezone: popupTimezone(tenant) });
      }
      if (req.method === 'GET' && !id) {
        const popups = await allAffiliationRows(() => db.from('cms_popup')
          .select('id,name,status,config,microsite_id,revision,dismissal_generation,starts_at,ends_at,updated_at', { count: 'exact' }).eq('tenant_id', tenantId));
        return res.json({ popups });
      }
      const existing = id ? await popupQuery(db.from('cms_popup').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle()) : null;
      if (id && !existing) return res.status(404).json({ error: 'Popup not found' });
      if (req.method === 'GET') {
        const popup = req.query?.preview === '1'
          ? { ...existing, ...await resolvePopupDesign(db, tenantId, existing, true) } : existing;
        return res.json({ popup });
      }
      const body = req.body || {};
      if (id && (!Number.isInteger(body.revision) || existing.revision !== body.revision)) return res.status(409).json({ error: 'Popup changed. Reload before saving.' });
      let action = req.method === 'DELETE' ? 'delete' : req.method === 'POST' && !id ? 'create' : body.action || 'save';
      if (!['create', 'save', 'delete', 'duplicate', 'reset-dismissals', 'archive', 'restore', 'pause'].includes(action)
        || (!id && action !== 'create') || (id && action === 'create')) return res.status(400).json({ error: 'Invalid popup action' });
      if (['delete', 'reset-dismissals'].includes(action) && body.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation required' });
      let document = existing ? { ...existing } : { name: body.name, microsite_id: body.microsite_id || null,
        design: POPUP_EMPTY_DESIGN, config: structuredClone(POPUP_DEFAULT_CONFIG), status: 'draft', starts_at: null, ends_at: null };
      if (action === 'save') {
        for (const key of ['name', 'design', 'config', 'status', 'starts_at', 'ends_at']) {
          if (Object.hasOwn(body, key)) document[key] = body[key];
        }
        if (Object.hasOwn(body, 'microsite_id') && body.microsite_id !== existing.microsite_id) return res.status(400).json({ error: 'Site scope cannot be changed. Create a new popup.' });
      }
      if (['archive', 'restore', 'pause'].includes(action)) {
        document.status = { archive: 'archived', restore: 'draft', pause: 'paused' }[action];
        action = 'save';
      }
      if (['create', 'save'].includes(action)) {
        if (document.microsite_id && !isPopupId(document.microsite_id)) return res.status(400).json({ error: 'Invalid microsite' });
        if (document.microsite_id) {
          const site = await popupQuery(db.from('microsite').select('id').eq('tenant_id', tenantId).eq('id', document.microsite_id).eq('is_active', true).maybeSingle());
          if (!site) return res.status(400).json({ error: 'Microsite unavailable' });
        }
        await validatePopupDocument(db, tenantId, document, await discoverPopupFields(db, tenantId));
        document.name = document.name.trim();
      }
      const popup = await popupQuery(db.rpc('cms_popup_save', {
        p_tenant: tenantId, p_id: id || null, p_revision: body.revision || null, p_document: document, p_action: action,
      }));
      return res.status(action === 'create' || action === 'duplicate' ? 201 : 200).json({ success: true, popup });
    } catch (error) {
      console.error('[CMS popups admin]', error.code || error.message);
      return res.status(error.code === '40001' ? 409 : error.status || 503)
        .json({ error: error.status === 400 ? error.message : error.code === '40001' ? 'Popup changed. Reload before saving.' : 'Popup request could not be completed. Please retry.' });
    }
  };
}
export default createPopupAdminHandler();
