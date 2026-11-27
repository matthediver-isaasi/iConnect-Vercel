import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { handleMemberGroupMembers } from './member-group-members.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories } from '../_lib/resourceCategoryAccess.js';
import { extractVideoEmbedSrc } from '../../client/src/lib/resourceVideoEmbed.mjs';
import { groupPinnedResourcesFirst } from '../../shared/resourcePinOrder.mjs';
import {
  readRows, readPublicGroup, readGroupResource, guestResourceEligible,
  projectGroupResource, persistedResourceStorageTarget, guestForumVisible,
  authorizedResourceStorageTarget, guestGroupForumEligible,
} from '../_lib/publicMemberGroupAccess.js';

const pick = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
const pageRange = req => {
  const page = Math.min(10000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  return [(page - 1) * 24, page * 24 - 1];
};
export function createPublicGroupContentHandler({
  db = supabase, resolveTenant = resolveTenantFromRequest,
  storageOrigin = process.env.SUPABASE_URL,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const missing = () => res.status(404).json({ error: 'Group content not found or unavailable.' });
    try {
      if (!db) return res.status(503).json({ error: 'Service unavailable.' });
      const tenant = await resolveTenant(req);
      if (!tenant) return missing();
      const group = await readPublicGroup(db, tenant.id, req.query.groupId);
      if (!group) return missing();
      const action = req.query.action || 'detail';
      const [start, end] = pageRange(req);
      if (action === 'detail') {
        const settings = await readRows(db.from('system_settings').select('setting_key,setting_value')
          .eq('tenant_id', tenant.id).in('setting_key', ['member_group_default_terms_of_reference', 'member_group_allow_terms_override']));
        const values = Object.fromEntries(settings.map(s => [s.setting_key, s.setting_value]));
        const terms = values.member_group_allow_terms_override === 'false'
          ? values.member_group_default_terms_of_reference
          : group.terms_of_reference || values.member_group_default_terms_of_reference;
        return res.json({ ...pick(group, ['id', 'name', 'description', 'who_is_it_for', 'about_the_group', 'header_image_url', 'forum_enabled']),
          terms_of_reference: terms || '', forum_enabled: guestGroupForumEligible(group) });
      }
      if (action === 'members') {
        // Existing directory privacy/expiry logic, with the narrow server projection.
        return handleMemberGroupMembers({ ...req, query: { groupId: group.id, page: req.query.page, limit: 24,
          presentation: 'public_group' } }, res, { supabase: db, tenant });
      }
      if (action === 'resources') {
        const hidden = computeHiddenSubcategories(await fetchCategoriesWithAccess(db, tenant.id), { isGuest: true });
        // Load complete eligible sources before editorial ordering/pagination.
        // Keep category names in a bound overlaps parameter, never raw filters.
        const readAll = async (makeQuery) => {
          const rows = [];
          for (let offset = 0; ; offset += 1000) {
            const batch = await readRows(makeQuery().order('id').range(offset, offset + 999));
            rows.push(...batch);
            if (batch.length < 1000) return rows;
          }
        };
        const owned = await readAll(() => db.from('resource').select('*').eq('tenant_id', tenant.id)
          .eq('member_group_id', group.id).eq('status', 'active'));
        const linked = group.resource_subcategories?.length
          ? await readAll(() => db.from('resource').select('*').eq('tenant_id', tenant.id).is('member_group_id', null)
            .eq('status', 'active').overlaps('subcategories', group.resource_subcategories)) : [];
        const matches = groupPinnedResourcesFirst([...owned, ...linked]
          .filter(r => guestResourceEligible(r, group, hidden))
          .sort((a, b) => new Date(b.published_date || b.created_date || 0).getTime()
            - new Date(a.published_date || a.created_date || 0).getTime()), group.id);
        return res.json({ records: matches.slice(start, end + 1).map(projectGroupResource),
          hasMore: matches.length > end + 1 });
      }
      if (action === 'resource' || action === 'download') {
        if (typeof req.query.resourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(req.query.resourceId)) return missing();
        const resource = await readGroupResource(db, tenant.id, group, req.query.resourceId);
        if (!resource) return missing();
        const storage = await authorizedResourceStorageTarget(db, resource, tenant.id, group, storageOrigin);
        if (action === 'resource') {
          const result = projectGroupResource(resource);
          result.can_download = !!storage;
          // External reading links only; forms keep their own transaction rules.
          if (resource.resource_type === 'video') result.embed_url = extractVideoEmbedSrc(resource.target_url);
          if (!storage && ['external_link', 'download'].includes(resource.resource_type)
            && /^https?:\/\//i.test(resource.target_url || '')
            && !resource.target_url.includes('/storage/v1/')) result.target_url = resource.target_url;
          return res.json(result);
        }
        // Client bucket/path parameters are never consulted.
        if (!storage) return missing();
        const { data, error } = await db.storage.from(storage.bucket).createSignedUrl(storage.path, 60, { download: true });
        if (error || !data?.signedUrl) throw error || new Error('Signing failed');
        return res.json({ url: data.signedUrl });
      }
      if (action === 'events') {
        const records = [];
        let hasMore = false;
        for (const [table, enabled, complex] of [['event', group.events_enabled, false], ['complex_event', group.complex_events_enabled, true]]) {
          if (!enabled) continue;
          const rows = await readRows(db.from(table).select('*')
            .eq('tenant_id', tenant.id).eq('member_group_id', group.id).order('id').range(start, end));
          hasMore ||= rows.length === 24;
          records.push(...rows.filter(r => r.event_state !== 'draft' && ['published', 'tbc', 'immediate'].includes(r.status))
            .filter(r => complex || r.pricing_config?.ticket_classes_configured === true || r.pricing_config?.ticket_classes?.length > 0)
            .map(r => ({ ...pick(r, ['id', 'title', 'description', 'start_date', 'end_date', 'location']), is_complex: complex })));
        }
        return res.json({ records, hasMore });
      }
      if (action === 'vacancies') {
        const records = await readRows(db.from('vacancy')
          .select('id,role_title,role_description,closing_date,positions_available,commitment_value,commitment_unit,term_value,term_unit')
          .eq('tenant_id', tenant.id).eq('member_group_id', group.id).eq('status', 'open').order('id').range(start, end));
        return res.json({ records, hasMore: records.length === 24 });
      }
      if (!['threads', 'thread'].includes(action) || !guestGroupForumEligible(group)) return missing();
      const categories = await readRows(db.from('forum_category').select('id,name')
        .eq('tenant_id', tenant.id).eq('group_id', group.id).eq('is_active', true).order('id').limit(100));
      if (!categories.length) return action === 'threads' ? res.json({ records: [], hasMore: false }) : missing();
      let query = db.from('forum_thread').select('*').eq('tenant_id', tenant.id)
        .in('category_id', categories.map(c => c.id))
        .or('is_hidden.is.null,is_hidden.eq.false');
      if (action === 'threads') {
        const threads = await readRows(query.order('created_at', { ascending: false }).order('id').range(start, end));
        return res.json({ records: threads.filter(guestForumVisible).map(t => pick(t, ['id', 'title', 'created_at'])), hasMore: threads.length === 24 });
      }
      if (typeof req.query.threadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(req.query.threadId)) return missing();
      const thread = (await readRows(query.eq('id', req.query.threadId).limit(1)))[0];
      if (!guestForumVisible(thread)) return missing();
      const posts = await readRows(db.from('forum_post').select('*')
        .eq('tenant_id', tenant.id).eq('thread_id', thread.id)
        .or('is_hidden.is.null,is_hidden.eq.false').or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at').order('id').range(start, end));
      const visiblePosts = posts.filter(guestForumVisible);
      const authorIds = [...new Set(visiblePosts.filter(p => p.created_by_type === 'member').map(p => p.created_by).filter(Boolean))];
      const authors = authorIds.length ? await readRows(db.from('member').select('id,first_name,last_name')
        .eq('tenant_id', tenant.id).in('id', authorIds)
        .or('show_in_directory.is.null,show_in_directory.eq.true')
        .or('login_enabled.is.null,login_enabled.eq.true')
        .not('email', 'ilike', 'deleted_%@deleted.local')) : [];
      const authorNames = new Map(authors.map(a => [a.id, [a.first_name, a.last_name].filter(Boolean).join(' ')]));
      return res.json({ thread: pick(thread, ['id', 'title']), records: visiblePosts.map(p => ({
        ...pick(p, ['id', 'content', 'created_at']),
        author_name: authorNames.get(p.created_by) || (p.created_by_type === 'tenant_user' ? 'Group moderator' : 'Group member'),
        image_urls: (Array.isArray(p.image_urls) ? p.image_urls : []).slice(0, 10).flatMap(url => {
          const stored = persistedResourceStorageTarget(url, tenant.id, storageOrigin);
          if (!stored || stored.bucket !== 'public-assets' || !stored.path.startsWith(`${tenant.id}/forum/`)) return [];
          // Only already-public forum images, never arbitrary signed/private files.
          return [`${new URL(storageOrigin).origin}/storage/v1/object/public/public-assets/${stored.path.split('/').map(encodeURIComponent).join('/')}`];
        }),
      })), hasMore: posts.length === 24 });
    } catch (error) {
      console.error('[Public group content]', error?.message);
      return res.status(503).json({ error: 'Unable to load group content. Please try again.' });
    }
  };
}
export default createPublicGroupContentHandler();
