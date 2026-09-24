import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeEngagementReport,
  createEngagementReportHandler,
  ENGAGEMENT_REPORT_FEATURE,
} from './engagement-report.js';

function roleDb({ role = { excluded_features: [] }, error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'role');
      const filters = [];
      calls.push({ table, filters });
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        async maybeSingle() { return { data: role, error }; },
      };
      return query;
    },
  };
}

const memberContext = {
  isAuthenticated: true,
  tenantId: 'tenant-a',
  memberId: 'member-a',
  roleId: 'role-a',
  memberExcludedFeatures: [],
};

test('access requires an authenticated tenant and rejects tenant mismatches', async () => {
  assert.deepEqual(await authorizeEngagementReport({ tenantId: 'tenant-a' }, roleDb()), {
    allowed: false, status: 401, error: 'Authentication required',
  });
  assert.deepEqual(await authorizeEngagementReport({
    ...memberContext, tenantMismatch: true,
  }, roleDb()), {
    allowed: false, status: 409, error: 'Tenant context mismatch',
  });
});

test('tenant dashboard users retain the explicit admin bypass', async () => {
  let read = false;
  const db = { from() { read = true; throw new Error('must not read a role'); } };
  assert.deepEqual(await authorizeEngagementReport({
    isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'tenant-user-a',
  }, db), { allowed: true });
  assert.equal(read, false);
});

test('member roles are looked up inside the authenticated tenant', async () => {
  const db = roleDb();
  assert.deepEqual(await authorizeEngagementReport(memberContext, db), { allowed: true });
  assert.deepEqual(db.calls[0].filters, [
    ['tenant_id', 'tenant-a'],
    ['id', 'role-a'],
  ]);
});

test('direct, parent, and legacy report exclusions are enforced', async () => {
  for (const excluded of [
    ENGAGEMENT_REPORT_FEATURE,
    'reports',
    'page_OrganisationEngagementReport',
    'page_admin_OrganisationEngagementReport',
  ]) {
    const result = await authorizeEngagementReport(memberContext, roleDb({
      role: { excluded_features: [excluded] },
    }));
    assert.equal(result.allowed, false, `${excluded} must deny report access`);
    assert.equal(result.status, 403);
  }
});

test('per-member exclusions are combined with role exclusions', async () => {
  const result = await authorizeEngagementReport({
    ...memberContext,
    memberExcludedFeatures: [ENGAGEMENT_REPORT_FEATURE],
  }, roleDb());
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
});

test('report access is independent of portal admin access', async () => {
  const allowed = await authorizeEngagementReport(memberContext, roleDb({
    role: { excluded_features: ['admin.role-management'] },
  }));
  assert.equal(allowed.allowed, true);
  const denied = await authorizeEngagementReport(memberContext, roleDb({
    role: { excluded_features: ['admin.role-management', ENGAGEMENT_REPORT_FEATURE] },
  }));
  assert.equal(denied.allowed, false);
});

test('missing, cross-tenant, and failed role reads fail closed', async () => {
  for (const db of [
    roleDb({ role: null }),
    roleDb({ role: null, error: new Error('database error') }),
  ]) {
    const result = await authorizeEngagementReport(memberContext, db);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
  }
  const thrown = {
    from() { throw new Error('database unavailable'); },
  };
  assert.equal((await authorizeEngagementReport(memberContext, thrown)).allowed, false);
  assert.equal((await authorizeEngagementReport({
    ...memberContext, roleId: null,
  }, roleDb())).allowed, false);
});

function reportDb() {
  const calls = [];
  const rows = {
    role: [{ excluded_features: [] }],
    member: [{
      id: 'member-a',
      first_name: 'Alex',
      last_name: 'Able',
      email: 'alex@example.test',
      organization_id: 'org-a',
      last_activity: null,
      login_enabled: true,
      profile_photo_url: null,
    }],
    organization: [
      { id: 'org-a', name: 'Tenant A Organisation', tenant_id: 'tenant-a' },
      { id: 'org-foreign', name: 'Foreign Organisation', tenant_id: 'tenant-b' },
    ],
  };
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const query = {
        select() { return query; },
        eq(column, value) { call.filters.push(['eq', column, value]); return query; },
        not(column, operator, value) { call.filters.push(['not', column, operator, value]); return query; },
        in(column, value) { call.filters.push(['in', column, value]); return query; },
        order() { return query; },
        async maybeSingle() {
          const tenant = call.filters.find(item => item[1] === 'tenant_id')?.[2];
          const id = call.filters.find(item => item[1] === 'id')?.[2];
          const data = tenant === 'tenant-a' && id === 'role-a' ? rows.role[0] : null;
          return { data, error: null };
        },
        async range() {
          return { data: rows.member, error: null };
        },
        then(resolve, reject) {
          try {
            let data = rows[table] || [];
            for (const filter of call.filters) {
              if (filter[0] === 'eq') data = data.filter(row => row[filter[1]] === filter[2]);
              if (filter[0] === 'in') data = data.filter(row => filter[2].includes(row[filter[1]]));
            }
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('the API authorizes before report reads and tenant-scopes organisation reads', async () => {
  const deniedDb = reportDb();
  const deniedHandler = createEngagementReportHandler({
    db: deniedDb,
    getTenantContext: async () => ({ tenantId: 'tenant-a', isAuthenticated: false }),
  });
  const deniedResponse = response();
  await deniedHandler({ method: 'GET', query: {} }, deniedResponse);
  assert.equal(deniedResponse.statusCode, 401);
  assert.equal(deniedDb.calls.length, 0, 'unauthorized requests must not read report tables');

  const db = reportDb();
  const handler = createEngagementReportHandler({
    db,
    getTenantContext: async () => memberContext,
  });
  const res = response();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.organizations.length, 1);
  assert.equal(res.body.organizations[0].organizationName, 'Tenant A Organisation');
  const organizationRead = db.calls.find(call => call.table === 'organization');
  assert.ok(organizationRead);
  assert.ok(organizationRead.filters.some(filter =>
    filter[0] === 'eq' && filter[1] === 'tenant_id' && filter[2] === 'tenant-a'));
});