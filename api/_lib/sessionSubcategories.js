import { isSubcategoryVisibleInCategory } from './resourceCategoryAccess.js';
export { sessionCategoryViewer, guardGenericSessionCategories, PUBLIC_SESSION_FIELDS } from './sessionCategories.js';
import { PUBLIC_SESSION_FIELDS } from './sessionCategories.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = 'id, name, subcategories, is_active, display_order, excluded_role_ids, subcategory_excluded_role_ids';
const keyFor = (id, name) => `${id}:${name}`;
function parseKey(key) {
  if (typeof key !== 'string' || !UUID.test(key.slice(0, 36)) || key[36] !== ':' || !key.slice(37).trim()) return null;
  return { categoryId: key.slice(0, 36), name: key.slice(37) };
}
function invalid() {
  return Object.assign(new Error('Choose valid active subcategories from this organisation'), { status: 400 });
}
function options(categories, viewer) {
  return categories.filter(c => c.is_active !== false).flatMap(c =>
    [...new Set(Array.isArray(c.subcategories) ? c.subcategories : [])]
      .filter(name => typeof name === 'string' && name.trim() && isSubcategoryVisibleInCategory(c, name, viewer))
      .map(name => ({ id: keyFor(c.id, name), name, category_id: c.id, category_name: c.name,
        display_order: c.display_order, is_active: true })));
}
async function lookup(db, tenantId, keys) {
  const ids = [...new Set(keys.map(parseKey).filter(Boolean).map(k => k.categoryId))];
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await db.from('resource_category').select(FIELDS)
      .eq('tenant_id', tenantId).in('id', ids.slice(offset, offset + 200));
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Subcategory catalogue unavailable');
    rows.push(...data);
  }
  return rows.sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.id.localeCompare(b.id));
}
export async function listSessionCategories(db, tenantId, viewer) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('resource_category').select(FIELDS)
      .eq('tenant_id', tenantId).order('display_order', { ascending: true })
      .order('id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Subcategory catalogue unavailable');
    rows.push(...data);
    if (data.length < 500) return options(rows, viewer);
  }
}
export async function validateSessionCategoryIds(db, tenantId, value, previous = [], viewer = { isPrivileged: true }) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(key => !parseKey(key))) throw invalid();
  const keys = [...new Set(value)];
  const old = new Set(previous || []);
  const rows = await lookup(db, tenantId, [...new Set([...keys, ...old])]);
  const allowed = new Set(options(rows, viewer).map(o => o.id));
  // Retaining historical/hidden choices is not permission to add new ones.
  if (keys.some(key => !allowed.has(key) && !old.has(key))) throw invalid();
  return viewer.isPrivileged ? keys : [...new Set([...keys, ...[...old].filter(key => !allowed.has(key))])];
}
export function projectPublicSession(session) {
  return Object.fromEntries([...PUBLIC_SESSION_FIELDS, 'subcategory_keys']
    .filter(key => Object.hasOwn(session, key)).map(key => [key, session[key]]));
}
export async function resolveSessionCategories(db, tenantId, sessions, viewer = { isGuest: true }, { keepIds = false } = {}) {
  const keys = [...new Set((sessions || []).flatMap(s => s.subcategory_keys || []))];
  const visible = options(await lookup(db, tenantId, keys), viewer);
  return (sessions || []).map(({ category_ids, subcategory_keys = [], ...session }) => ({
    ...session,
    ...(keepIds ? { subcategory_keys: viewer.isPrivileged ? subcategory_keys : visible.filter(o => subcategory_keys.includes(o.id)).map(o => o.id) } : {}),
    categories: visible.filter(o => subcategory_keys.includes(o.id)).map(({ id, name, category_name }) => ({ id, name, category_name })),
  }));
}
