import {
  validatePopupConfig, validatePopupGroups, validatePopupDesign, validatePopupSchedule,
  popupScheduleAvailable, popupFrequencyAllows, evaluatePopupAudience,
} from '../../shared/cmsPopupContract.js';
import { discoverPopupFields, loadPopupAudience } from './cmsPopupAudience.js';
import { allAffiliationRows } from './formAffiliationReview.js';
import { projectMemberOnlyGuest } from '../../shared/canvasMemberOnly.js';

export async function popupQuery(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
export function popupTimezone(tenant) {
  const timezone = tenant.settings?.timezone || 'Europe/London';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return timezone;
}
export function popupRuntimeRecord(popup, state) {
  const { groups, page_ids, ...config } = popup.config;
  return { id: popup.id, revision: popup.revision, dismissal_generation: popup.dismissal_generation,
    ends_at: popup.ends_at, config, last_shown_at: state?.last_shown_at || null };
}
export async function validatePopupDocument(db, tenantId, document, fields) {
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.trim().length > 120) throw Object.assign(new Error('Name must be between 1 and 120 characters.'), { status: 400 });
  if (!['draft', 'active', 'paused', 'archived'].includes(document.status)) throw Object.assign(new Error('Invalid lifecycle.'), { status: 400 });
  validatePopupConfig(document.config);
  validatePopupGroups(document.config.groups, fields);
  const orgIds = [...new Set(document.config.groups.flatMap(g => g.conditions)
    .filter(c => c.entity_scope === 'organization' && c.field_type === 'core' && c.field_key === 'id')
    .flatMap(c => Array.isArray(c.value) ? c.value : [c.value]))];
  if (orgIds.length) {
    const organizations = await allAffiliationRows(() => db.from('organization').select('id', { count: 'exact' })
      .eq('tenant_id', tenantId).in('id', orgIds), 200);
    if (organizations.length !== orgIds.length) throw Object.assign(new Error('Selected organisations must belong to this tenant.'), { status: 400 });
  }
  validatePopupSchedule(document.starts_at, document.ends_at);
  await resolvePopupDesign(db, tenantId, document, true);
  const ids = [...new Set(document.config.page_ids)];
  if (ids.length) {
    const pages = await allAffiliationRows(() => db.from('i_edit_page').select('id,microsite_id', { count: 'exact' })
      .eq('tenant_id', tenantId).in('id', ids), 500);
    if (pages.length !== ids.length || pages.some(p => (p.microsite_id || null) !== (document.microsite_id || null))) {
      throw Object.assign(new Error('Pages must belong to the popup’s site and tenant.'), { status: 400 });
    }
  }
  if (document.status === 'active' && !document.config.all_pages && !ids.length) throw Object.assign(new Error('Assign at least one page before activation.'), { status: 400 });
}
export async function resolvePopupDesign(db, tenantId, popup, memberContent) {
  const design = memberContent ? popup.design : projectMemberOnlyGuest(popup.design);
  const requested = validatePopupDesign(design);
  if (requested.length > 50) throw new Error('Too many popup symbols.');
  const symbols = requested.length ? await allAffiliationRows(() => db.from('canvas_symbol')
    .select('id,name,design', { count: 'exact' }).eq('tenant_id', tenantId).in('id', requested), 50) : [];
  if (symbols.length !== requested.length) throw new Error('A popup symbol is unavailable.');
  const projected = symbols.map(symbol => memberContent ? symbol : projectMemberOnlyGuest(symbol));
  for (const symbol of projected) {
    // Existing Canvas symbols are one-level; explicitly reject nesting rather
    // than falling back to an unscoped public symbol catalogue.
    if (validatePopupDesign(symbol.design).length) throw new Error('Nested popup symbols are unsupported.');
  }
  return { design, symbols: projected };
}
export async function eligiblePopups(db, tenant, page, viewer, { id = null, now = Date.now(), ignoreFrequency = false, allowPermanentReplay = false, measure = async (_name, work) => work() } = {}) {
  let query = db.from('cms_popup').select('*', { count: 'exact' }).eq('tenant_id', tenant.id).eq('status', 'active');
  if (id) query = query.eq('id', id);
  query = page.microsite_id ? query.eq('microsite_id', page.microsite_id) : query.is('microsite_id', null);
  // Overflow is a hard failure, not a silently truncated candidate set.
  const { data, error, count } = await measure('candidates', () => query.order('id').range(0, 100));
  if (error || !Array.isArray(data) || count !== data.length || count > 100) throw new Error('Complete popup candidates unavailable.');
  const rows = data.filter(p => popupScheduleAvailable(p, now) && (p.config.all_pages || p.config.page_ids?.includes(page.id)));
  if (!rows.length) return [];
  const fields = await measure('fields', () => discoverPopupFields(db, tenant.id));
  rows.forEach(p => { validatePopupConfig(p.config); validatePopupGroups(p.config.groups, fields); });
  const timezone = popupTimezone(tenant);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const loadStates = async () => {
    if (!viewer.memberId) return [];
    // Compound-key table deliberately has no synthetic id. Filter each current
    // generation in one OR rather than loading unbounded historical resets.
    const { data: saved, error: stateError, count: stateCount } = await db.from('cms_popup_member_state')
      .select('*', { count: 'exact' }).eq('tenant_id', tenant.id).eq('member_id', viewer.memberId)
      .or(rows.map(p => `and(popup_id.eq.${p.id},generation.eq.${p.dismissal_generation})`).join(','))
      .order('popup_id').range(0, 100);
    if (stateError || !Array.isArray(saved) || stateCount !== saved.length || stateCount > 100) throw new Error('Popup preferences unavailable.');
    return saved;
  };
  // Both reads are independently tenant/member scoped. Do not serialize the
  // preference read behind potentially expensive membership/affiliation reads.
  const [{ member, organizations }, states] = await Promise.all([
    measure('audience', () => loadPopupAudience(db, tenant.id, viewer.memberId, rows.map(p => p.config), fields,
      { today: `${parts.year}-${parts.month}-${parts.day}` })),
    measure('preferences', loadStates),
  ]);
  return rows.flatMap(p => {
    const state = states.find(s => s.popup_id === p.id && s.generation === p.dismissal_generation);
    if ((!allowPermanentReplay && state?.permanently_dismissed) || (!ignoreFrequency && !popupFrequencyAllows(p.config.frequency, state, timezone, now))
      || !evaluatePopupAudience(p.config, viewer, fields, member, organizations)) return [];
    return [{ popup: p, state }];
  });
}
