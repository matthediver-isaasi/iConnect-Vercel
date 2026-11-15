import { isCategoryVisibleToViewer } from './resourceCategoryAccess.js';
import { hasAdminAccess, hasFeatureAccess } from './tenantContext.js';

export async function sessionCategoryViewer(context) {
  return {
    isGuest: !context?.isAuthenticated, roleId: context?.roleId || null,
    isPrivileged: !!context?.isAuthenticated && (await hasAdminAccess(context)
      || (!!context.roleId && await hasFeatureAccess(context.roleId, 'content.resource-management'))),
  };
}

export async function listSessionCategories(db, tenantId, viewer) {
  const visible = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('resource_category')
      .select('id, name, is_active, display_order, excluded_role_ids')
      .eq('tenant_id', tenantId).order('display_order', { ascending: true })
      .order('id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Category catalogue unavailable');
    visible.push(...data.filter(c => c.is_active !== false && isCategoryVisibleToViewer(c, viewer))
      .map(({ id, name, display_order, is_active }) => ({ id, name, display_order, is_active })));
    // Terminate against the unfiltered page, never the visible subset.
    if (data.length < 500) return visible;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PUBLIC_SESSION_FIELDS = [
  'id', 'title', 'description', 'image_url', 'image_focal_point', 'speaker_names', 'speaker_ids',
  'start_time', 'end_time', 'location', 'is_online', 'display_order', 'complex_event_id',
];
export function projectPublicSession(session) {
  return Object.fromEntries([...PUBLIC_SESSION_FIELDS, 'category_ids'].filter(key => Object.hasOwn(session, key)).map(key => [key, session[key]]));
}
function invalid() {
  return Object.assign(new Error('Choose valid active categories from this organisation'), { status: 400 });
}

export async function validateSessionCategoryIds(db, tenantId, value, previous = [], viewer = { isPrivileged: true }) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !UUID.test(id))) throw invalid();
  const ids = [...new Set(value.map(id => id.toLowerCase()))];
  const old = new Set(previous || []);
  // A limited editor only receives visible, active assignments. Their full-form
  // save is not authority to remove IDs the server deliberately withheld.
  const lookupIds = viewer.isPrivileged ? ids : [...new Set([...ids, ...old])];
  if (!lookupIds.length) return [];
  const { data, error } = await db.from('resource_category').select('id, is_active, excluded_role_ids')
    .eq('tenant_id', tenantId).in('id', lookupIds);
  if (error) throw error;
  const active = new Set((data || []).filter(c => c.is_active !== false).map(c => c.id));
  // Retain unavailable historical assignments until the editor explicitly removes
  // them. They never resolve into badges, and cannot be newly assigned.
  if (ids.some(id => !active.has(id) && !old.has(id))) throw invalid();
  if ((data || []).some(c => ids.includes(c.id) && !isCategoryVisibleToViewer(c, viewer) && !old.has(c.id))) throw invalid();
  if (!viewer.isPrivileged) {
    const editable = new Set((data || []).filter(c => c.is_active !== false && isCategoryVisibleToViewer(c, viewer)).map(c => c.id));
    return [...new Set([...ids, ...[...old].filter(id => !editable.has(id))])];
  }
  return ids;
}

export async function resolveSessionCategories(db, tenantId, sessions, viewer = { isGuest: true }, { keepIds = false } = {}) {
  const ids = [...new Set((sessions || []).flatMap(s => s.category_ids || []))];
  const categories = [];
  // Bound each IN query and page implicitly by its requested unique IDs.
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await db.from('resource_category')
      .select('id, name, is_active, display_order, excluded_role_ids')
      .eq('tenant_id', tenantId).in('id', ids.slice(offset, offset + 200));
    // Do not degrade a failed policy lookup into unrestricted labels.
    if (error) throw error;
    categories.push(...(data || []));
  }
  categories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.id.localeCompare(b.id));
  const visible = categories.filter(c => c.is_active !== false && isCategoryVisibleToViewer(c, viewer));
  return (sessions || []).map(({ category_ids = [], ...session }) => ({
    ...session,
    ...(keepIds ? { category_ids: viewer.isPrivileged ? category_ids : visible.filter(c => category_ids.includes(c.id)).map(c => c.id) } : {}),
    categories: visible.filter(c => category_ids.includes(c.id)).map(({ id, name }) => ({ id, name })),
  }));
}

// The generic API is not a badge discovery API. Its unrestricted projections
// must neither alias assignments nor search them to infer restricted IDs.
export function guardGenericSessionCategories(req, res, entityNorm) {
  if (/category_ids|complex_event_session/i.test(String(req.query?.expand || ''))
    || (entityNorm === 'complexeventsession' && req.query?.expand)) {
    res.status(400).json({ error: 'Use the session API for session category projections' });
    return true;
  }
  if (entityNorm !== 'complexeventsession') return false;
  if (/category_ids/i.test(JSON.stringify([req.query?.filter, req.query?.sort]))) {
    res.status(400).json({ error: 'Session category filtering is not supported' });
    return true;
  }
  const json = res.json.bind(res);
  const strip = value => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'category_ids').map(([key, val]) => [key, strip(val)]));
  };
  res.json = value => json(strip(value));
  return false;
}
