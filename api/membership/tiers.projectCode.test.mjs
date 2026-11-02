import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMembershipProjectCode } from '../../shared/membershipProjectCode.js';
import { parseFlatMembershipCost } from '../../shared/membershipFlatCost.js';

function fixture() {
  const rows = [
    { id: 'own', tenant_id: 'a', effective_from: '2025-01-01', effective_to: null, xero_project_code: null },
    { id: 'other', tenant_id: 'b', effective_from: '2025-01-01', effective_to: null, xero_project_code: 'OTHER' },
    { id: 'old', tenant_id: 'a', effective_from: '2024-01-01', effective_to: '2024-12-31', xero_project_code: 'OLD' },
  ];
  const db = { from(table) {
    let filters = [], patch, inserting, remove = false, single = false;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      is(k, v) { return q.eq(k, v); }, order() { return q; }, limit() { return q; },
      update(value) { patch = value; return q; }, insert(value) { inserting = value; return q; },
      delete() { remove = true; return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      then(resolve, reject) {
        try {
          let data = table === 'membership_tier_config' ? rows.filter(r => filters.every(f => f(r))) : [];
          if (patch) data.forEach(r => Object.assign(r, structuredClone(patch)));
          if (inserting) { const row = { id: 'new', ...inserting }; rows.push(row); data = [row]; }
          if (remove) throw new Error('Unexpected delete');
          return Promise.resolve({ data: single ? structuredClone(data[0] || null) : structuredClone(data), error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return q;
  } };
  const source = readFileSync(new URL('./tiers.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/export default /g, '').replace(/export /g, '');
  const handler = new Function('supabase', 'getTenantContext', 'hasAdminAccess', 'normalizeMembershipProjectCode',
    'parseFlatMembershipCost', 'normalizeInvoiceRecipients', 'validateInvoiceRecipientsShape',
    'getRemindersForConfig', 'getActiveAccountingProvider',
    `${source}\nreturn handler;`)(db, async req => ({ tenantId: req.tenant || 'a', isAuthenticated: true }),
    async req => true, normalizeMembershipProjectCode, parseFlatMembershipCost, () => ({}), () => null,
    async () => [], async () => 'xero');
  const call = async (method, config, query = {}) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body: { config }, query }, res);
    return res;
  };
  return { rows, call };
}

for (const pricing_model of ['flat', 'tiered']) {
  test(`${pricing_model}: API saves, reloads, changes and clears without touching another tenant`, async () => {
    const { call, rows } = fixture();
    const config = { id: 'own', pricing_model, flat_cost: 100, effective_from: '2025-01-01', structure_scope_type: 'member' };
    for (const [input, expected] of [[' MEMBERSHIPS ', 'MEMBERSHIPS'], ['NEXT', 'NEXT'], ['', null]]) {
      const saved = await call('POST', { ...config, xero_project_code: input });
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
      const reloaded = await call('GET', null, { configId: 'own' });
      assert.equal(reloaded.body.config.xero_project_code, expected);
      assert.equal(rows.find(r => r.id === 'other').xero_project_code, 'OTHER');
    }
    await call('POST', { ...config, xero_project_code: 'KEEP' });
    await call('PUT', config);
    assert.equal(rows[0].xero_project_code, 'KEEP', 'omitted field must preserve settings from hidden/older clients');
    assert.equal((await call('POST', { ...config, id: 'other', xero_project_code: 'BAD' })).statusCode, 404);
    assert.equal((await call('POST', { ...config, id: 'old', xero_project_code: 'BAD' })).statusCode, 400);
    assert.equal(rows[2].xero_project_code, 'OLD');
  });
}
