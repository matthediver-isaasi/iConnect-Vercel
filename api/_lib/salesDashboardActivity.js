import { hasAdminAccess } from './tenantContext.js';
import { loadSalesTenantUsers } from './salesPrincipals.js';
import { SalesHttpError } from './salesAccess.js';

const MAX_SCAN = 50000;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const index = rows => new Map((rows || []).map(row => [String(row.id), row]));
const time = row => Date.parse(row.created_at);
const personName = row => [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || null;

// Read only qualifying history, in bounded ID batches and stable pages. Never
// limit an unfiltered audit stream: maintenance must not displace milestones.
async function history(db, tenantId, table, columns, key, ids, qualify = q => q, orderColumn = 'id') {
  const rows = [];
  for (let start = 0; start < ids.length; start += 100) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await qualify(db.from(table).select(columns)
        .eq('tenant_id', tenantId).in(key, ids.slice(start, start + 100)))
        .order(orderColumn).range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (rows.length > MAX_SCAN) throw new SalesHttpError(413, 'Sales activity exceeds the maximum scan');
      if ((data || []).length < 1000) break;
    }
  }
  return rows;
}

export function buildSalesActivity(data = {}) {
  const opportunities = index(data.opportunities);
  const quotes = index(data.quotes);
  const stages = index(data.stages);
  const organisations = index(data.organisations);
  const versions = index(data.versions);
  const events = [];
  const add = (source, row, kind, description, quoteId, opportunityId, actorKind, actorId) => {
    if (!Number.isFinite(time(row))) return;
    const quote = quoteId ? quotes.get(String(quoteId)) : null;
    const opportunity = opportunities.get(String(opportunityId || quote?.opportunity_id));
    if (quoteId ? !quote : !opportunity) return;
    // A linked quote cannot inherit visibility from a missing/inaccessible deal.
    if (quote?.opportunity_id && !opportunity) return;
    const version = versions.get(String(row.quote_version_id));
    events.push({
      id: `${source}:${row.id}`, kind, date: row.created_at, description,
      opportunityId: opportunity?.id || null, opportunityName: text(opportunity?.name),
      quoteId: quote?.id || null, quoteNumber: text(quote?.quote_number),
      organizationName: text(organisations.get(String(opportunity?.organization_id))?.name)
        || text(version?.organisation_snapshot?.name),
      actorName: data.actorNames?.[`${actorKind}:${actorId}`]
        || (actorKind === 'customer' ? 'Customer' : actorKind === 'system' ? 'System'
          : actorId ? 'Name unavailable' : 'Actor not recorded'),
      _actorKind: actorKind, _actorId: actorId,
    });
  };
  const sales = data.sales || [];
  const stagesHistory = data.stageHistory || [];
  const stageKey = row => JSON.stringify([row.opportunity_id, row.from_stage_id, row.to_stage_id, time(row)]);
  const stageKeys = new Set(stagesHistory.map(stageKey));
  const saleVersions = new Set(sales.map(row => `${row.quote_id}:${row.quote_version_id}`));
  const saleTimes = new Set(sales.map(row => `${row.opportunity_id}:${time(row)}`));
  const outcomeKey = (row, status) => JSON.stringify([row.quote_id, row.quote_version_id, status, time(row)]);
  const outcomeKeys = new Set((data.quoteHistory || []).map(row => outcomeKey(row, row.to_status)));
  for (const row of stagesHistory) {
    if (!row.from_stage_id || row.from_stage_id === row.to_stage_id) continue;
    // The confirmation transaction writes both a sale and its won-stage move.
    if (row.note === 'Commercial sale confirmed' && saleTimes.has(`${row.opportunity_id}:${time(row)}`)) continue;
    const from = text(stages.get(String(row.from_stage_id))?.name) || 'Previous stage unavailable';
    const to = text(stages.get(String(row.to_stage_id))?.name) || 'Stage unavailable';
    add('stage', row, 'stage', `Stage moved: ${from} → ${to}`, null, row.opportunity_id, row.actor_kind, row.actor_id);
  }
  // Older activity-only evidence is useful, but the paired transactional history
  // is authoritative when the exact move/time is present.
  for (const row of data.activities || []) {
    if (row.action !== 'stage.changed') continue;
    const from = row.metadata?.fromStageId;
    const to = row.metadata?.toStageId;
    if (!from || !to || from === to || stageKeys.has(stageKey({ ...row, from_stage_id: from, to_stage_id: to }))) continue;
    add('activity', row, 'stage', `Stage moved: ${text(stages.get(String(from))?.name) || 'Previous stage unavailable'} → ${text(stages.get(String(to))?.name) || 'Stage unavailable'}`,
    null, row.opportunity_id, row.actor_kind, row.actor_id);
  }
  const sentTokens = new Set();
  for (const row of (data.deliveries || []).slice().sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id)))) {
    if (row.event_type !== 'sent') continue;
    if (row.token_id && sentTokens.has(row.token_id)) continue;
    if (row.token_id) sentTokens.add(row.token_id);
    add('send', row, 'sent', 'Proposal sent', row.quote_id, null,
      row.request_metadata?.actor_type, row.actor_id);
  }
  for (const row of data.quoteHistory || []) {
    if (!['accepted', 'declined', 'converted'].includes(row.to_status) || row.from_status === row.to_status) continue;
    // Lifecycle cancellation is not a customer's rejection.
    if (row.actor_type === 'system' && row.note === 'Cancelled by staff; unsold exhibition reservations released') continue;
    if (row.to_status === 'converted' && saleVersions.has(`${row.quote_id}:${row.quote_version_id}`)) continue;
    add('outcome', row, row.to_status,
      row.to_status === 'converted' ? 'Proposal converted' : row.to_status === 'accepted' ? 'Proposal accepted' : 'Proposal rejected',
      row.quote_id, null, row.actor_type, row.actor_id);
  }
  for (const row of sales) add('sale', row, 'confirmed', 'Commercial sale confirmed',
    row.quote_id, row.opportunity_id, row.confirmed_by_kind, row.confirmed_by_id);
  // Customer-decision audit mirrors status history. Only use it when the exact
  // transaction's status row is absent; never use current version status.
  for (const row of [...(data.decisions || []).map(row => ({ ...row, event_type: row.decision })), ...(data.deliveries || [])]) {
    if (!['accepted', 'declined'].includes(row.event_type)) continue;
    const key = outcomeKey(row, row.event_type);
    if (outcomeKeys.has(key)) continue;
    outcomeKeys.add(key);
    add('decision', row, row.event_type, row.event_type === 'accepted' ? 'Proposal accepted' : 'Proposal rejected',
      row.quote_id, null, 'customer', null);
  }
  return events.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id))
    .slice(0, 8);
}

export async function loadSalesDashboardActivity(db, context, data, dependencies = {}) {
  const tenantId = context.tenantId;
  const admin = await (dependencies.hasAdminAccess || hasAdminAccess)(context);
  let opportunities = data.opportunities || [];
  if (!admin) {
    const kind = context.tenantUserId ? 'tenant_user' : 'member';
    const id = context.tenantUserId || context.memberId;
    const collaborations = await history(db, tenantId, 'opportunity_collaborator',
      'opportunity_id', 'principal_id', [id], q => q.eq('principal_kind', kind), 'opportunity_id');
    const allowed = new Set(collaborations.map(row => row.opportunity_id));
    opportunities = opportunities.filter(row => (row.owner_kind === kind && row.owner_id === id) || allowed.has(row.id));
  }
  const allowed = new Set(opportunities.map(row => row.id));
  const quotes = (data.quotes || []).filter(row => !row.exhibition_deleted_at
    && (!row.opportunity_id ? admin : allowed.has(row.opportunity_id)));
  const quoteIds = quotes.map(row => row.id);
  const opportunityIds = opportunities.map(row => row.id);
  const [stageHistory, activities, quoteHistory, deliveries, decisions] = await Promise.all([
    history(db, tenantId, 'opportunity_stage_history',
      'id,opportunity_id,from_stage_id,to_stage_id,actor_kind,actor_id,note,created_at', 'opportunity_id', opportunityIds),
    history(db, tenantId, 'opportunity_activity',
      'id,opportunity_id,action,metadata,actor_kind,actor_id,created_at', 'opportunity_id', opportunityIds, q => q.eq('action', 'stage.changed')),
    history(db, tenantId, 'sales_quote_status_history',
      'id,quote_id,quote_version_id,from_status,to_status,actor_type,actor_id,note,created_at', 'quote_id', quoteIds,
      q => q.in('to_status', ['accepted', 'declined', 'converted'])),
    history(db, tenantId, 'sales_quote_delivery_audit',
      'id,quote_id,quote_version_id,token_id,event_type,actor_id,request_metadata:request_metadata->actor_type,created_at', 'quote_id', quoteIds,
      q => q.in('event_type', ['sent', 'accepted', 'declined'])),
    history(db, tenantId, 'sales_quote_customer_decision',
      'id,quote_id,quote_version_id,decision,created_at', 'quote_id', quoteIds),
  ]);
  // Project just the actor kind out of request_metadata; sender/provider data is
  // neither loaded nor returned.
  for (const row of deliveries) row.request_metadata = { actor_type: row.request_metadata };
  const quoteSet = new Set(quoteIds);
  const source = { ...data, opportunities, quotes, stageHistory, activities, quoteHistory, deliveries, decisions,
    sales: (data.sales || []).filter(row => quoteSet.has(row.quote_id)
      && (!row.opportunity_id || allowed.has(row.opportunity_id))) };
  const recent = buildSalesActivity(source);
  const tenantUsers = recent.filter(row => row._actorKind === 'tenant_user' && row._actorId).map(row => row._actorId);
  const memberIds = recent.filter(row => row._actorKind === 'member' && row._actorId).map(row => row._actorId);
  const actorNames = {};
  if (tenantUsers.length) {
    const { data: users } = await loadSalesTenantUsers(db, tenantId, tenantUsers);
    for (const row of users) if (personName(row)) actorNames[`tenant_user:${row.id}`] = personName(row);
  }
  if (memberIds.length) {
    const { data: primary, error } = await db.from('organization').select('id')
      .eq('tenant_id', tenantId).eq('is_primary', true).maybeSingle();
    if (error) throw error;
    if (primary) {
      const { data: members, error: memberError } = await db.from('member').select('id,first_name,last_name')
        .eq('tenant_id', tenantId).eq('organization_id', primary.id).in('id', [...new Set(memberIds)])
        .or('email.is.null,email.not.ilike.deleted_%@deleted.local');
      if (memberError) throw memberError;
      for (const row of members || []) if (personName(row)) actorNames[`member:${row.id}`] = personName(row);
    }
  }
  return recent.map(({ _actorKind, _actorId, ...row }) => ({
    ...row, actorName: actorNames[`${_actorKind}:${_actorId}`] || row.actorName,
  }));
}
