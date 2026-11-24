// In-memory PostgREST-shaped database. Deliberately no legacy row for identity.
export function salesPrincipalFixture() {
  const rows = {
    organization: [{ id: 'org', tenant_id: 'tenant-a', name: 'Customer' },
      { id: 'team', tenant_id: 'tenant-a', is_primary: true }],
    member: [
      { id: 'contact', tenant_id: 'tenant-a', organization_id: 'org', first_name: 'Customer', email: 'contact@example.test' },
      { id: 'member-user', tenant_id: 'tenant-a', organization_id: 'team', first_name: 'Member', email: 'member@example.test' },
    ],
    tenant_user: [{ id: 'legacy', tenant_id: 'tenant-a', first_name: 'Legacy', email: 'legacy@example.test' }],
    tenant_identity: [
      { id: 'identity', first_name: 'Unified', last_name: 'Admin', email: 'admin@example.test' },
      ...['foreign', 'inactive', 'ordinary', 'absent', 'membership-owner', 'role-owner'].map(id => ({
        id, first_name: id, email: `${id}@example.test`,
      })),
    ],
    tenant_membership: [
      { identity_id: 'identity', tenant_id: 'tenant-a', status: 'active', role: 'member', membership_type: 'member' },
      { identity_id: 'identity', tenant_id: 'tenant-a', status: 'active', role: 'admin', membership_type: 'member' },
      { identity_id: 'foreign', tenant_id: 'tenant-b', status: 'active', role: 'admin' },
      { identity_id: 'inactive', tenant_id: 'tenant-a', status: 'inactive', role: 'admin' },
      { identity_id: 'ordinary', tenant_id: 'tenant-a', status: 'active', role: 'member', membership_type: 'admin' },
      { identity_id: 'missing-identity', tenant_id: 'tenant-a', status: 'active', role: 'admin' },
      { identity_id: 'membership-owner', tenant_id: 'tenant-a', status: 'active', role: 'member', membership_type: 'owner' },
      { identity_id: 'role-owner', tenant_id: 'tenant-a', status: 'active', role: 'owner', membership_type: 'member' },
    ],
    opportunity_stage: [{ id: 'stage', tenant_id: 'tenant-a', name: 'Open', is_active: true }],
    opportunity: [], opportunity_collaborator: [], opportunity_contact_role: [],
  };
  const calls = [];
  const failures = new Map();
  const db = { rows, calls, failures, from(table) {
    let selected = [...(rows[table] || [])], inserted, patch;
    calls.push({ table });
    const result = () => {
      if (failures.has(table)) return { data: null, error: failures.get(table) };
      if (patch) for (const row of selected) Object.assign(row, patch);
      if (inserted) {
        selected = (Array.isArray(inserted) ? inserted : [inserted]).map(row => ({ id: 'created', version: 1, ...row }));
        (rows[table] ||= []).push(...selected);
        if (table === 'opportunity' && selected[0].primary_contact_id) rows.opportunity_contact_role.push({
          tenant_id: selected[0].tenant_id, opportunity_id: selected[0].id,
          member_id: selected[0].primary_contact_id, is_primary: true, role: 'Primary contact',
        });
      }
      return { data: selected, error: null, count: selected.length };
    };
    const q = {
      select() { return q; },
      eq(k, v) { selected = selected.filter(row => row[k] === v); return q; },
      in(k, values) { selected = selected.filter(row => values.includes(row[k])); return q; },
      is(k, v) { selected = selected.filter(row => (row[k] ?? null) === v); return q; },
      or(clause) {
        if (table === 'tenant_membership') selected = selected.filter(row =>
          ['admin', 'owner'].includes(row.role) || row.membership_type === 'owner');
        else if (table === 'opportunity') {
          const match = clause.match(/owner_id.eq.([^)]+)/);
          if (match) selected = selected.filter(row => row.owner_id === match[1]);
        }
        return q;
      },
      order() { return q; },
      limit(n) { selected = selected.slice(0, n); return q; },
      range(a, b) { selected = selected.slice(a, b + 1); return Promise.resolve(result()); },
      insert(row) { inserted = row; return q; },
      update(row) { patch = row; return q; },
      maybeSingle() { const r = result(); return Promise.resolve({ ...r, data: r.data?.[0] || null }); },
      single() { return q.maybeSingle(); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return q;
  } };
  return db;
}

export const unifiedContext = {
  isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'identity',
};
export function salesResponse() {
  return { status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; return this; }, setHeader() {} };
}
