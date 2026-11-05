// Pure contracts shared by authoring, delivery and isolated tests.
export const POPUP_BLOCK_TYPES = Object.freeze([
  'box', 'section', 'row', 'group', 'text', 'image', 'button', 'spacer',
  'divider', 'vertical-divider', 'icon', 'card', 'stat', 'accordion',
  'advanced-accordion', 'columns', 'logo-strip', 'symbol',
]);
export const POPUP_DEFAULT_CONFIG = Object.freeze({
  visibility: 'public', all_pages: false, page_ids: [], groups: [],
  trigger: { type: 'immediate', value: 0 },
  frequency: { type: 'page_view', days: 1 },
  priority: 0, allow_session: true, allow_permanent: true,
  modal: { width: 800, max_height: 90, padding: 24, background: '#ffffff',
    overlay: '#00000080', border_color: '#e2e8f0', border_width: 0, radius: 12,
    shadow: 'lg', close_position: 'right' },
});
export const POPUP_EMPTY_DESIGN = { version: 1, root: { sections: [] } };
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export const isPopupId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function validatePopupDesign(design) {
  if (!object(design) || ![1, 2].includes(design.version) || !Array.isArray(design.root?.sections)) fail('A valid Canvas document is required.');
  if (JSON.stringify(design).length > 1000000) fail('Popup design is too large.');
  let count = 0;
  const symbols = new Set();
  function visit(node, depth = 0) {
    if (!object(node) || depth > 20 || ++count > 500) fail('Popup design exceeds supported complexity.');
    if (node.type && !POPUP_BLOCK_TYPES.includes(node.type)) fail(`Unsupported popup block: ${node.type}`);
    if (node.type === 'symbol') {
      if (!isPopupId(node.content?.symbolId)) fail('A valid symbol is required.');
      symbols.add(node.content.symbolId);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) fail('Invalid Canvas children.');
      node.children.forEach(child => visit(child, depth + 1));
    }
    if (node.type === 'advanced-accordion') {
      if (!Array.isArray(node.content?.items)) fail('Invalid accordion panels.');
      node.content.items.forEach(item => {
        if (!Array.isArray(item.children)) fail('Invalid accordion content.');
        item.children.forEach(child => visit(child, depth + 1));
      });
    }
  }
  design.root.sections.forEach(section => visit(section));
  return [...symbols];
}

export function popupOperators(type) {
  const base = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
  if (['text', 'email', 'url'].includes(type)) return [...base, 'contains'];
  if (['number', 'decimal'].includes(type)) return [...base, 'greater_than', 'less_than'];
  if (type === 'boolean') return ['is_true', 'is_false', 'is_empty', 'is_not_empty'];
  if (type === 'date') return [...base, 'before', 'after'];
  if (['picklist', 'dropdown'].includes(type)) return [...base, 'is_one_of'];
  if (['list', 'multiselect', 'multi_select', 'country', 'countries'].includes(type)) return ['contains', 'is_empty', 'is_not_empty'];
  return [];
}
export function validatePopupGroups(groups, fields) {
  if (!Array.isArray(groups) || groups.length > 10) fail('Use at most ten audience groups.');
  return groups.map(group => {
    if (!Array.isArray(group?.conditions) || !group.conditions.length || group.conditions.length > 20) fail('Each audience group needs one to twenty conditions.');
    return group.conditions.map(condition => {
      if (!['member', 'organization'].includes(condition?.entity_scope)) fail('Unsupported audience scope.');
      const field = fields[condition.entity_scope]?.[condition.field_type]?.find(f => f.key === condition.field_key);
      if (!field || field.data_type !== condition.data_type || !popupOperators(field.data_type).includes(condition.operator)) fail('An audience field or operator is unavailable.');
      if (condition.entity_scope === 'organization' && condition.field_type === 'core' && condition.field_key === 'id'
        && (!['equals', 'is_one_of'].includes(condition.operator)
          || (Array.isArray(condition.value) ? condition.value : [condition.value]).some(id => !isPopupId(id)))) {
        fail('Select valid organisations using Equals or Is one of.');
      }
      if (!['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(condition.operator)) {
        if (condition.value == null || condition.value === '' || (Array.isArray(condition.value) && !condition.value.length)) fail('An audience comparison value is required.');
        if (JSON.stringify(condition.value).length > 4000) fail('Audience comparison value is too large.');
        if (['number', 'decimal'].includes(field.data_type) && numeric(condition.value) === null) fail('A numeric comparison value is required.');
        if (field.data_type === 'date' && dateValue(condition.value) === null) fail('A valid comparison date is required.');
      }
      return { ...condition, data_type: field.data_type };
    });
  });
}
function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(+parsedDay) || parsedDay.toISOString().slice(0, 10) !== day) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
export function matchPopupCondition(actual, condition) {
  const { operator: op, value, data_type: type } = condition;
  let a = actual;
  if (['list', 'multiselect', 'multi_select', 'country', 'countries'].includes(type) && typeof a === 'string' && a.startsWith('[')) {
    try { a = JSON.parse(a); } catch { return false; }
  }
  const empty = a == null || a === '' || (Array.isArray(a) && a.length === 0);
  if (op === 'is_empty') return empty;
  if (op === 'is_not_empty') return !empty;
  if (empty) return false; // Missing never satisfies negative comparisons or false.
  if (op === 'is_true') return a === true || a === 'true';
  if (op === 'is_false') return a === false || a === 'false';
  const convert = ['number', 'decimal'].includes(type) ? numeric : type === 'date' ? dateValue
    : v => typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  const left = convert(a), right = convert(value);
  if (op === 'contains' && Array.isArray(a)) {
    const values = Array.isArray(value) ? value : [value];
    return a.some(v => values.some(w => convert(v) !== null && convert(v) === convert(w)));
  }
  if (op === 'is_one_of') return left !== null && (Array.isArray(value) ? value : [value]).some(v => convert(v) === left);
  if (left === null || right === null) return false;
  if (op === 'equals') return left === right;
  if (op === 'not_equals') return left !== right;
  if (op === 'contains') return typeof left === 'string' && left.toLowerCase().includes(String(right).toLowerCase());
  if (op === 'greater_than' || op === 'after') return left > right;
  if (op === 'less_than' || op === 'before') return left < right;
  return false;
}
export function evaluatePopupAudience(config, viewer, fields, member, organizations = []) {
  // Validate EVERY condition before evaluating ORs. Invalid branches cannot disappear.
  const groups = validatePopupGroups(config.groups, fields);
  if (config.visibility === 'guests' && viewer.isAuthenticated) return false;
  if (config.visibility === 'members' && !viewer.memberId) return false;
  if (!groups.length) return true;
  if (!viewer.memberId || !member || member.id !== viewer.memberId) return false;
  const matches = (row, c) => matchPopupCondition(c.field_type === 'custom' ? row.custom?.[c.field_key] : row[c.field_key], c);
  return groups.some(conditions => {
    const memberConditions = conditions.filter(c => c.entity_scope === 'member');
    const orgConditions = conditions.filter(c => c.entity_scope === 'organization');
    return memberConditions.every(c => matches(member, c))
      && (!orgConditions.length || organizations.some(org => orgConditions.every(c => matches(org, c))));
  });
}
export function validatePopupConfig(config) {
  if (!object(config)) fail('Popup configuration is required.');
  if (!['public', 'members', 'guests'].includes(config.visibility)) fail('Invalid audience visibility.');
  if (typeof config.all_pages !== 'boolean' || !Array.isArray(config.page_ids) || config.page_ids.length > 500 || config.page_ids.some(id => !isPopupId(id))) fail('Invalid page assignments.');
  if (!Array.isArray(config.groups)) fail('Invalid audience groups.');
  if (!integer(config.priority, -10000, 10000)) fail('Priority must be an integer between -10000 and 10000.');
  if (typeof config.allow_session !== 'boolean' || typeof config.allow_permanent !== 'boolean') fail('Invalid dismissal settings.');
  if (!['immediate', 'delay', 'scroll_percent', 'scroll_pixels'].includes(config.trigger?.type)
    || !integer(config.trigger.value, 0, config.trigger.type === 'scroll_percent' ? 100 : 86400)) fail('Invalid trigger.');
  if (!['page_view', 'session', 'day', 'n_days', 'until_dismissed'].includes(config.frequency?.type)
    || !integer(config.frequency.days, 1, 3650)) fail('Invalid frequency.');
  const m = config.modal;
  if (!object(m) || !integer(m.width, 240, 1600) || !integer(m.max_height, 20, 95)
    || !integer(m.padding, 0, 100) || !integer(m.border_width, 0, 20) || !integer(m.radius, 0, 200)
    || !['none', 'sm', 'md', 'lg', 'xl'].includes(m.shadow)
    || !['left', 'right'].includes(m.close_position)
    || ['background', 'overlay', 'border_color'].some(k => !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(m[k]))) fail('Invalid modal appearance.');
  return config;
}
export function popupScheduleAvailable(row, now = Date.now()) {
  return row.status === 'active' && (!row.starts_at || Date.parse(row.starts_at) <= now)
    && (!row.ends_at || now < Date.parse(row.ends_at));
}
export function validatePopupSchedule(start, end) {
  for (const value of [start, end]) {
    if (value != null && (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || dateValue(value) === null)) fail('Schedule must include an explicit UTC offset.');
  }
  if (start && end && Date.parse(start) >= Date.parse(end)) fail('End must be later than start.');
}
export function popupFrequencyAllows(frequency, state, timezone, now = Date.now()) {
  if (state?.permanently_dismissed) return false;
  if (!state?.last_shown_at) return true;
  const last = Date.parse(state.last_shown_at);
  if (!Number.isFinite(last)) return false;
  if (frequency.type === 'n_days') return now - last >= frequency.days * 86400000;
  if (frequency.type === 'day') {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return format.format(new Date(last)) !== format.format(new Date(now));
  }
  return true; // Session decisions belong to this browser, never to cross-device state.
}
