// Write boundary only. Booking/read enforcement lives in ticketAccess.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class TicketAudienceWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TicketAudienceWriteError';
    this.statusCode = 400;
    this.status = 400;
  }
}

function invalid(message) {
  throw new TicketAudienceWriteError(message);
}

function parsePricing(value) {
  if (value == null || value === '') return null; // Historical empty pricing.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { invalid('pricing_config must contain valid JSON.'); }
  }
  if (value === null) return null;
  if (!object(value)) invalid('pricing_config must be an object.');
  if (value.ticket_classes != null && !Array.isArray(value.ticket_classes)) {
    invalid('pricing_config.ticket_classes must be an array.');
  }
  return value;
}

async function normalizeTicket({ db, tenantId, ticket, explicitMode }) {
  if (!object(ticket)) invalid('Each ticket class must be an object.');
  const mode = ticket.audience_mode ?? 'legacy';
  if (!['legacy', 'selected_members'].includes(mode)) {
    invalid('audience_mode must be legacy or selected_members.');
  }
  const out = { ...ticket };
  // A deliberate return to legacy must not leave an inactive allowlist that
  // could accidentally reactivate later. Never infer lists from legacy roles.
  if (mode === 'legacy' && explicitMode) {
    out.selected_member_ids = [];
    return out;
  }
  if (ticket.selected_member_ids != null && !Array.isArray(ticket.selected_member_ids)) {
    invalid('selected_member_ids must be an array of member UUIDs.');
  }
  const supplied = ticket.selected_member_ids ?? [];
  if (supplied.some(id => typeof id !== 'string' || !UUID.test(id))) {
    invalid('selected_member_ids must contain only valid member UUIDs.');
  }
  const ids = [...new Set(supplied.map(id => id.toLowerCase()))];
  if (mode === 'legacy') {
    if (ids.length) invalid('selected_member_ids requires audience_mode selected_members.');
    return out; // Preserve missing/null legacy fields; no backfill.
  }
  if (!Array.isArray(ticket.selected_member_ids)) {
    invalid('Selected-members tickets require a selected_member_ids array (which may be empty).');
  }
  if (ticket.visibility_mode !== 'members_only') {
    invalid('Selected-members tickets must use members_only visibility.');
  }
  for (const field of ['role_ids', 'member_group_ids']) {
    if (ticket[field] != null && (!Array.isArray(ticket[field]) || ticket[field].length > 0)) {
      invalid(`Selected-members tickets cannot also use ${field} restrictions.`);
    }
  }
  if (ticket.role_match_only != null && ticket.role_match_only !== false) {
    invalid('Selected-members tickets cannot also use role_match_only.');
  }
  if ((ticket.auto_create_guest_accounts != null && ticket.auto_create_guest_accounts !== false)
    || (ticket.create_member_records != null && ticket.create_member_records !== false)
    || (ticket.new_member_role_id != null && ticket.new_member_role_id !== '')) {
    invalid('Selected-members tickets cannot create member/contact records.');
  }
  if (!tenantId || !UUID.test(tenantId) || !db) invalid('A valid tenant is required to select members.');
  // member.tenant_id is canonical. Do not accept IDs based on roles, email,
  // organization, tenant_user links, or a client-supplied member snapshot.
  const found = new Set();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const { data, error } = await db.from('member').select('id')
      .eq('tenant_id', tenantId).in('id', batch);
    if (error || !Array.isArray(data)) invalid('Unable to verify selected members. Please retry saving.');
    for (const row of data) if (typeof row.id === 'string') found.add(row.id.toLowerCase());
  }
  if (ids.some(id => !found.has(id))) {
    invalid('Every selected member must exist in this tenant.');
  }
  out.audience_mode = 'selected_members';
  out.selected_member_ids = ids;
  return out;
}

/**
 * Returns a new write payload. PATCH row fields merge with existingRow; a
 * supplied pricing_config replaces JSON (matching the generic entity API).
 * Call after authorization and before insert/update; persist the returned body.
 */
export async function validateTicketAudienceWrite({ db, tenantId, entity, body, existingRow = null }) {
  const name = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  if (!['event', 'complexeventticketclass'].includes(name)) return body;
  if (Array.isArray(body)) {
    return Promise.all(body.map((record, i) => validateTicketAudienceWrite({
      db, tenantId, entity, body: record,
      existingRow: Array.isArray(existingRow) ? existingRow[i] : null,
    })));
  }
  if (!object(body)) invalid('Ticket write body must be an object.');
  const merged = { ...(existingRow || {}), ...body };
  if (existingRow?.tenant_id && existingRow.tenant_id !== tenantId) {
    invalid('Ticket does not belong to this tenant.');
  }
  if (own(body, 'tenant_id') && body.tenant_id !== tenantId) {
    invalid('Ticket tenant cannot be changed.');
  }
  if (name === 'complexeventticketclass') {
    if (existingRow) {
      if (own(body, 'complex_event_id') && body.complex_event_id !== existingRow.complex_event_id) {
        invalid('A ticket class cannot be moved to another complex event.');
      }
    } else {
      if (typeof body.complex_event_id !== 'string' || !UUID.test(body.complex_event_id) || !tenantId || !db) {
        invalid('A valid tenant-owned complex_event_id is required.');
      }
      const { data, error } = await db.from('complex_event').select('id')
        .eq('tenant_id', tenantId).eq('id', body.complex_event_id).maybeSingle();
      if (error || !data) invalid('The complex event must exist in this tenant.');
    }
    const normalized = await normalizeTicket({
      db, tenantId, ticket: merged,
      explicitMode: own(body, 'audience_mode') && (body.audience_mode == null || body.audience_mode === 'legacy'),
    });
    const out = { ...body };
    // Keep PATCH narrow, but persist canonical IDs or a deliberate clear.
    if (normalized.audience_mode === 'selected_members' || own(normalized, 'selected_member_ids')) {
      out.selected_member_ids = normalized.selected_member_ids;
    }
    return out;
  }
  const pricing = parsePricing(merged.pricing_config);
  if (!pricing) return { ...body };
  const tickets = await Promise.all((pricing.ticket_classes || []).map(ticket => normalizeTicket({
    db, tenantId, ticket,
    explicitMode: object(ticket) && own(ticket, 'audience_mode')
      && (ticket.audience_mode == null || ticket.audience_mode === 'legacy'),
  })));
  if (!own(body, 'pricing_config')) return { ...body };
  const normalized = { ...pricing };
  if (own(pricing, 'ticket_classes')) normalized.ticket_classes = tickets;
  return {
    ...body,
    pricing_config: typeof body.pricing_config === 'string' ? JSON.stringify(normalized) : normalized,
  };
}
