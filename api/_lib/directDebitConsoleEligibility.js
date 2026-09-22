import { isDeletedRelationshipMember } from './customObjectMemberEligibility.js';

// Console-only visibility. Never use this policy in collection/background jobs.
export async function readConsoleRows(makeQuery) {
  const rows = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const { data, error } = await makeQuery().range(offset, offset + 499);
    if (error) throw new Error(`Direct Debit console lookup failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('Direct Debit console lookup returned no data');
    rows.push(...data);
    if (data.length < 500) return rows;
  }
  throw new Error('Direct Debit console population exceeds safe read bound');
}

export async function lookupConsoleRows(db, tenantId, table, ids, columns = '*') {
  const result = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let n = 0; n < unique.length; n += 100) {
    const { data, error } = await db.from(table).select(columns)
      .eq('tenant_id', tenantId).in('id', unique.slice(n, n + 100));
    if (error) throw new Error(`Direct Debit console ${table} lookup failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`Direct Debit console ${table} lookup returned no data`);
    for (const row of data) if (row.tenant_id === tenantId) result.set(row.id, row);
  }
  return result;
}

export async function filterConsoleRows(db, tenantId, rows) {
  if (!tenantId) throw new Error('Direct Debit console tenant required');
  const plans = await lookupConsoleRows(db, tenantId, 'membership_payment_plans', rows.map(r => r.plan_id));
  const agreements = await lookupConsoleRows(db, tenantId, 'membership_billing_agreements', [
    ...rows.flatMap(r => [r.billing_agreement_id, r.previous_agreement_id]),
    ...[...plans.values()].map(p => p.billing_agreement_id),
  ]);
  const members = await lookupConsoleRows(db, tenantId, 'member',
    [...rows, ...plans.values(), ...agreements.values()].map(r => r.member_id),
    'id, tenant_id, email');
  const organizations = await lookupConsoleRows(db, tenantId, 'organization',
    [...rows, ...plans.values(), ...agreements.values()].map(r => r.organization_id),
    'id, tenant_id');
  return rows.filter(row => {
    if (row.tenant_id && row.tenant_id !== tenantId) return false;
    const owners = [row];
    if (row.plan_id) {
      const plan = plans.get(row.plan_id);
      if (!plan) return false;
      owners.push(plan);
    }
    for (const id of new Set(owners.flatMap(r => [r.billing_agreement_id, r.previous_agreement_id]).filter(Boolean))) {
      const agreement = agreements.get(id);
      if (!agreement) return false;
      owners.push(agreement);
    }
    const ids = [...new Set(owners.map(r => r.member_id).filter(Boolean))];
    const orgIds = [...new Set(owners.map(r => r.organization_id).filter(Boolean))];
    // Conflicting canonical owners are not safe to expose or act upon.
    if (ids.length > 1 || orgIds.length > 1 || orgIds.some(id => !organizations.has(id))) return false;
    if (ids.length) return ids.every(id => members.has(id) && !isDeletedRelationshipMember(members.get(id)));
    return orgIds.length === 1;
  });
}

// Shared tables also contain Stripe plans. Opt in at DD-only boundaries rather
// than changing the dual-provider renewal ledger's identity policy.
export async function filterDirectDebitRows(db, tenantId, rows, { plans = false } = {}) {
  const visible = await filterConsoleRows(db, tenantId, rows);
  const canonicalPlans = plans
    ? new Map(visible.map(row => [row.id, row]))
    : await lookupConsoleRows(db, tenantId, 'membership_payment_plans', visible.map(row => row.plan_id));
  const agreements = await lookupConsoleRows(db, tenantId, 'membership_billing_agreements', [
    ...visible.map(row => row.billing_agreement_id),
    ...[...canonicalPlans.values()].map(row => row.billing_agreement_id),
  ]);
  return visible.filter(row => {
    const plan = canonicalPlans.get(plans ? row.id : row.plan_id);
    if ((plans || row.plan_id) && (!plan || plan.provider !== 'gocardless' || !plan.billing_agreement_id)) return false;
    const agreementIds = [...new Set([row.billing_agreement_id, plan?.billing_agreement_id].filter(Boolean))];
    if (!agreementIds.length || agreementIds.length > 1) return false;
    if (row.provider != null && row.provider !== 'gocardless') return false;
    return agreementIds.every(id => agreements.get(id)?.provider === 'gocardless');
  });
}

export function paginateConsolePlans(plans, query = {}) {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw Object.assign(new Error('page must be positive and pageSize must be between 1 and 200'), { statusCode: 400 });
  }
  const start = (page - 1) * pageSize;
  return { plans: plans.slice(start, start + pageSize), total: plans.length, page, pageSize, hasMore: start + pageSize < plans.length };
}