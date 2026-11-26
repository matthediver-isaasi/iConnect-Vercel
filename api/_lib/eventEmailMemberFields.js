// Fills {{field_name}} tokens from the ATTENDEE's own member custom fields.
// The attendee is identified by email within the tenant, never by the booking's
// purchasing member (a group purchaser is not necessarily this attendee).
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function displayValue(raw) {
  if (raw == null) return '';
  let value = raw;
  if (typeof raw === 'string' && /^[[{"]/.test(raw.trim())) {
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  if (Array.isArray(value)) return value.filter(v => v != null && v !== '').join(', ');
  if (value && typeof value === 'object') return '';
  return String(value);
}

export async function loadAttendeeMemberFieldValues(db, { tenantId, attendeeEmail, texts }) {
  const names = new Set();
  for (const text of texts) for (const match of String(text || '').matchAll(TOKEN)) names.add(match[1]);
  if (!names.size || !tenantId || !attendeeEmail) return {};
  const fields = await db.from('preference_field').select('id,name').eq('tenant_id', tenantId)
    .eq('entity_scope', 'member').eq('is_active', true).in('name', [...names]);
  if (fields.error) throw new Error('Member custom fields could not be loaded');
  if (!fields.data?.length) return {};
  const members = await db.from('member').select('id').eq('tenant_id', tenantId)
    .ilike('email', String(attendeeEmail).trim().replace(/([\\%_])/g, '\\$1')).limit(2);
  if (members.error) throw new Error('Attendee member could not be loaded');
  const values = Object.fromEntries(fields.data.map(field => [field.name, '']));
  // No member, or an ambiguous email: leave the fields blank rather than guess.
  if (members.data?.length !== 1) return values;
  const stored = await db.from('member_preference_value').select('field_id,value')
    .eq('member_id', members.data[0].id).in('field_id', fields.data.map(field => field.id));
  if (stored.error) throw new Error('Member custom field values could not be loaded');
  for (const field of fields.data) {
    const row = stored.data?.find(r => r.field_id === field.id);
    values[field.name] = displayValue(row?.value);
  }
  return values;
}

// Replaces only tokens naming a loaded member field; other tokens are untouched.
export function applyMemberFieldPlaceholders(text, values, { html = true } = {}) {
  if (!text) return text;
  return String(text).replace(TOKEN, (token, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (html ? escapeHtml(values[name]) : values[name]) : token);
}
