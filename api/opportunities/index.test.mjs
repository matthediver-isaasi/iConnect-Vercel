import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunitiesHandler } from './index.js';
import { salesPrincipalFixture, unifiedContext, salesResponse } from '../_lib/salesPrincipals.fixture.mjs';

function fixture(admin = true, fail = false) {
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: [], orders: [] }; calls.push(call);
    const q = {
      select(columns, options) { call.columns = columns; call.options = options; return q; },
      eq(key, value) { call.filters.push([key,value]); return q; },
      is(key, value) { call.filters.push([key,value]); return q; },
      not(key, operator, value) { call.filters.push([key,operator,value]); return q; },
      or(value) { call.or = value; return q; },
      ilike(key,value) { call.search = [key,value]; return q; },
      order(key,options) { call.orders.push([key,options]); return q; },
      range(from,to) { call.range = [from,to]; return Promise.resolve({data: [], count: 0, error: fail ? Error('lookup failed') : null}); },
      then(resolve) { return Promise.resolve({data: [{opportunity_id:'shared'}],error:null}).then(resolve); },
    }; return q;
  }};
  const handler = createOpportunitiesHandler({
    db, getTenantContext: async () => ({isAuthenticated:true,tenantId:'tenant-a',tenantUserId:'user-a'}),
    hasAdminAccess: async () => admin,
    requireCapability: async () => {},
  });
  const res = { statusCode:null, status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;} };
  return {calls,handler,res};
}
test('active opportunity search filters open stages before pagination with stable ordering', async () => {
  const f=fixture();
  await f.handler({method:'GET',query:{active:'true',search:'Conference',page:'2',pageSize:'25'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q=f.calls.find(c=>c.table==='opportunity');
  assert.match(q.columns,/opportunity_stage!inner/);
  assert.deepEqual(q.filters,[['tenant_id','tenant-a'],['archived_at',null],['active_stage.is_active',true],['active_stage.is_won',false],['active_stage.is_lost',false]]);
  assert.deepEqual(q.search,['name','%Conference%']);
  assert.deepEqual(q.range,[25,49]);
  assert.deepEqual(q.orders.map(v=>v[0]),['updated_at','id']);
  assert.equal(f.res.body.total,0);
});
test('active selector preserves tenant and owner/collaborator scope', async () => {
  const f=fixture(false);
  await f.handler({method:'GET',query:{active:'true'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q=f.calls.find(c=>c.table==='opportunity');
  assert.match(q.or,/owner_id.eq.user-a/);
  assert.match(q.or,/id.in.\(shared\)/);
  const roles=f.calls.find(c=>c.table==='opportunity_collaborator');
  assert.ok(roles.filters.some(([key,value])=>key==='tenant_id'&&value==='tenant-a'));
});
test('archived list is filtered before counting and pagination', async () => {
  const f = fixture(false);
  await f.handler({method:'GET',query:{archived:'true',page:'2'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q = f.calls.find(c => c.table === 'opportunity');
  assert.ok(q.filters.some(f => f[0] === 'archived_at' && f[1] === 'is' && f[2] === null));
  assert.match(q.or,/owner_id.eq.user-a/);
  assert.deepEqual(q.range,[25,49]);
});
test('ordinary opportunity lists retain closed stages; lookup errors are not empty success', async () => {
  const normal=fixture();
  await normal.handler({method:'GET',query:{}},normal.res);
  assert.equal(normal.calls[0].columns,'*');
  const failed=fixture(true,true);
  await failed.handler({method:'GET',query:{active:'true'}},failed.res);
  assert.ok(failed.res.statusCode>=400);
});

test('pipeline net projection enriches only scoped rows without rewriting the ordinary list contract', async () => {
  const db = salesPrincipalFixture();
  db.rows.opportunity.push({ id: 'converted', tenant_id: 'tenant-a', organization_id: 'org',
    stage_id: 'stage', owner_id: 'identity', owner_kind: 'tenant_user', archived_at: null,
    value_minor: 12000, currency: 'GBP' });
  db.rows.sales_quote = [{ id: 'q', tenant_id: 'tenant-a', opportunity_id: 'converted', current_version: 2 }];
  db.rows.sales_quote_version = [
    { id: 'v', tenant_id: 'tenant-a', quote_id: 'q', version_number: 1, net_minor: 10000, gross_minor: 12000, currency: 'GBP' },
    { id: 'new', tenant_id: 'tenant-a', quote_id: 'q', version_number: 2, net_minor: 20000, currency: 'GBP' },
    { id: 'foreign', tenant_id: 'tenant-b', quote_id: 'q', version_number: 1, net_minor: 999999, currency: 'GBP' },
  ];
  db.rows.sales_commercial_sale = [{ id: 'sale', tenant_id: 'tenant-a', opportunity_id: 'converted', quote_id: 'q', quote_version_id: 'v' }];
  const handler = createOpportunitiesHandler({ db, getTenantContext: async () => unifiedContext,
    requireCapability: async () => {}, hasAdminAccess: async () => true });
  const res = salesResponse();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].value_minor, 12000);
  assert.equal(res.body.items[0].netValueMinor, undefined);
  await handler({ method: 'GET', query: { moneyBasis: 'net' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].value_minor, 12000);
  assert.equal(res.body.items[0].netValueMinor, 10000);
  assert.equal(res.body.items[0].netValueSource, 'proposal');
  db.rows.sales_commercial_sale[0].opportunity_id = null;
  await handler({ method: 'GET', query: { moneyBasis: 'net' } }, res);
  assert.equal(res.body.items[0].netValueMinor, 10000, 'quote linkage retains the confirmed version even without sale.opportunity_id');
  db.failures.set('sales_quote_version', Error('evidence unavailable'));
  await handler({ method: 'GET', query: { moneyBasis: 'net' } }, res);
  assert.equal(res.statusCode, 500);
});

test('creation accepts every organisation status with an optional contact, but rejects another tenant', async () => {
  for (const status of ['Live', 'Pending', null]) {
    for (const contactId of [null, 'contact']) {
      let inserted;
      const db = { from(table) {
        const filters = {};
        const q = {
          select() { return q; },
          eq(key, value) { filters[key] = value; return q; },
          insert(row) { inserted = row; return q; },
          async single() { return { data: { id: 'created', ...inserted }, error: null }; },
          async maybeSingle() {
            assert.equal(filters.tenant_id, 'tenant-a');
            return { data: filters.id === 'other-tenant-org' ? null
              : { id: filters.id, application_status: status, organization_id: 'org', is_active: true }, error: null };
          },
        };
        return q;
      } };
      const handler = createOpportunitiesHandler({ db,
        getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'user' }),
        requireCapability: async () => {},
      });
      const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
      const body = { name: 'Sale', organizationId: 'org', stageId: 'stage', contactId };
      await handler({ method: 'POST', body }, res);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.organization_id, 'org');
      assert.equal(res.body.primary_contact_id, contactId);
      inserted = null;
      await handler({ method: 'POST', body: { ...body, organizationId: 'other-tenant-org' } }, res);
      assert.equal(res.statusCode, 404);
      assert.equal(inserted, null);
    }
  }
});

test('default creator and owner remain the authenticated Sales principal for both staff forms and members', async () => {
  for (const context of [unifiedContext, { ...unifiedContext, tenantUserId: 'legacy' },
    { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-user', roleId: 'sales-role' }]) {
    for (const contactId of [null, 'contact']) {
      const db = salesPrincipalFixture(), res = salesResponse();
      const handler = createOpportunitiesHandler({ db, getTenantContext: async () => context,
        hasFeatureAccess: async () => true, hasAdminAccess: async () => false });
      await handler({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage', contactId } }, res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      const kind = context.tenantUserId ? 'tenant_user' : 'member';
      const id = context.tenantUserId || context.memberId;
      assert.equal(res.body.owner_kind, kind);
      assert.equal(res.body.owner_id, id);
      assert.equal(res.body.created_by_id, id);
      assert.equal(res.body.created_by_kind, kind);
      assert.equal(res.body.primary_contact_id, contactId);
      await handler({ method: 'GET', query: { mine: 'true' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].owner.id, id);
      assert.equal(res.body.items[0].primaryContact?.id || null, contactId);
      if (id === 'identity') assert.equal(res.body.items[0].owner.name, 'Unified Admin');
    }
  }
});

test('invalid unified owners and database failures cannot create opportunities', async () => {
  for (const id of ['foreign', 'inactive', 'ordinary', 'absent', 'missing-identity']) {
    const db = salesPrincipalFixture(), res = salesResponse();
    const handler = createOpportunitiesHandler({ db, getTenantContext: async () => unifiedContext,
      requireCapability: async () => {} });
    await handler({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage',
      contactId: 'contact', owner: { kind: 'tenant_user', id } } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'Principal not found in tenant');
    assert.equal(db.rows.opportunity.length, 0);
  }
  for (const table of ['tenant_user', 'tenant_membership', 'tenant_identity']) {
    const db = salesPrincipalFixture(), res = salesResponse();
    db.failures.set(table, new Error('database unavailable'));
    await createOpportunitiesHandler({ db, getTenantContext: async () => unifiedContext,
      requireCapability: async () => {} })({ method: 'POST',
      body: { name: 'Sale', organizationId: 'org', stageId: 'stage' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(db.rows.opportunity.length, 0);
  }
});

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function taskChoiceFixture({ features = () => true, rpcError = null, identity = uid(4), unifiedStaff = false } = {}) {
  const inserted = [], rpcs = [];
  const records = {
    organization: { id: 'org', tenant_id: 'tenant-a' },
    opportunity_stage: { id: 'stage', tenant_id: 'tenant-a', is_active: true, is_lost: false },
    member: { id: uid(2), tenant_id: 'tenant-a', organization_id: 'org', identity_id: identity },
    tenant_identity: unifiedStaff ? { id: uid(20) } : null,
    tenant_membership: unifiedStaff ? [{ identity_id: uid(20), tenant_id: 'tenant-a', status: 'active', role: 'admin' }] : [],
  };
  const db = {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(key, value) { filters[key] = value; return q; },
        or() { return q; },
        limit() { return q; },
        insert(row) { inserted.push(row); return q; },
        async single() { return { data: { id: 'standard-created', ...inserted.at(-1) }, error: null }; },
        async maybeSingle() {
          const record = records[table];
          return { data: record && !Array.isArray(record) && Object.entries(filters).every(([key, value]) => record[key] === value) ? record : null, error: null };
        },
        then(resolve, reject) {
          const rows = Array.isArray(records[table]) ? records[table] : records[table] ? [records[table]] : [];
          return Promise.resolve({ data: rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      rpcs.push([name, args]);
      return rpcError ? { data: null, error: rpcError }
        : { data: { id: 'project-created', task_mode: 'project', project_board_id: uid(6), ...args.p_opportunity }, error: null };
    },
  };
  const handler = createOpportunitiesHandler({ db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', memberId: uid(2), roleId: 'role',
      ...(unifiedStaff ? { tenantUserId: uid(20) } : {}) }),
    hasFeatureAccess: async (role, key) => features(key), hasAdminAccess: async () => false });
  const send = async (extra) => {
    const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage', ...extra } }, res);
    return res;
  };
  return { send, inserted, rpcs };
}

test('task choice: standard keeps the direct insert; create and link use one atomic RPC with server identity', async () => {
  for (const extra of [{}, { taskChoice: 'standard' }]) {
    const f = taskChoiceFixture();
    const res = await f.send(extra);
    assert.equal(res.statusCode, 201);
    assert.equal(f.inserted.length, 1);
    assert.equal(f.rpcs.length, 0);
  }
  for (const [taskChoice, boardId] of [['create', undefined], ['link', uid(6)]]) {
    const f = taskChoiceFixture();
    const res = await f.send({ taskChoice, boardId, p_identity: uid(99), tenant_id: 'tenant-b' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.inserted.length, 0, 'No separate opportunity insert');
    assert.equal(f.rpcs.length, 1);
    const [name, args] = f.rpcs[0];
    assert.equal(name, 'create_sales_opportunity_with_project');
    assert.equal(args.p_tenant, 'tenant-a');
    assert.equal(args.p_kind, 'member');
    assert.equal(args.p_actor, uid(2));
    assert.equal(args.p_identity, uid(4));
    assert.equal(args.p_action, taskChoice);
    assert.equal(args.p_board, boardId || null);
    assert.equal(args.p_opportunity.name, 'Sale');
    assert.equal(args.p_opportunity.owner_id, uid(2));
    assert.equal('tenant_id' in args.p_opportunity, false);
    assert.equal('created_by_id' in args.p_opportunity, false);
    assert.equal(res.body.project_board_id, uid(6));
  }
});

test('unified staff opportunity creation and linking submit the verified staff identity, not an associated member', async () => {
  for (const taskChoice of ['create', 'link']) {
    const f = taskChoiceFixture({ unifiedStaff: true });
    const res = await f.send({ taskChoice, ...(taskChoice === 'link' ? { boardId: uid(6) } : {}), p_identity: uid(99) });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.inserted.length, 0);
    const [name, args] = f.rpcs[0];
    assert.equal(name, 'create_sales_opportunity_with_project');
    assert.equal(args.p_actor, uid(20));
    assert.equal(args.p_identity, uid(20));
    assert.equal(args.p_kind, 'tenant_user');
    assert.equal(args.p_opportunity.owner_id, uid(20));
  }
});

test('task choice: invalid input and missing Projects permissions never create an opportunity', async () => {
  for (const [extra, options, status] of [
    [{ taskChoice: 'when-won' }, {}, 400],
    [{ taskChoice: 'link' }, {}, 400],
    [{ taskChoice: 'link', boardId: 'not-a-uuid' }, {}, 400],
    [{ taskChoice: 'create' }, { features: key => key !== 'projects.boards.create' }, 403],
    [{ taskChoice: 'create' }, { features: key => key !== 'projects.board-view' }, 403],
    [{ taskChoice: 'link', boardId: uid(6) }, { features: key => key !== 'projects.board-view' }, 403],
    [{ taskChoice: 'link', boardId: uid(6) }, { identity: 'legacy-identity' }, 403],
  ]) {
    const f = taskChoiceFixture(options);
    const res = await f.send(extra);
    assert.equal(res.statusCode, status, JSON.stringify(extra));
    assert.equal(f.inserted.length, 0);
    assert.equal(f.rpcs.length, 0);
  }
  // Linking without board-create permission is still allowed.
  const f = taskChoiceFixture({ features: key => key !== 'projects.boards.create' });
  assert.equal((await f.send({ taskChoice: 'link', boardId: uid(6) })).statusCode, 201);
});

test('task choice: board conflicts and ineligible boards surface clear errors with no fallback insert', async () => {
  for (const [code, status, pattern] of [['23505', 409, /already linked/], ['42501', 403, /not available/],
    ['23514', 409, /stage/]]) {
    const f = taskChoiceFixture({ rpcError: Object.assign(new Error('A tenant stage is required'), { code }) });
    const res = await f.send({ taskChoice: 'link', boardId: uid(6) });
    assert.equal(res.statusCode, status);
    assert.match(res.body.error, pattern);
    assert.equal(f.inserted.length, 0);
  }
  const missing = taskChoiceFixture({ rpcError: Object.assign(new Error('Could not find the function'), { code: 'PGRST202' }) });
  const unavailable = await missing.send({ taskChoice: 'create' });
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body.error, /standard tasks/);
  assert.equal(missing.inserted.length, 0);
  const f = taskChoiceFixture({ rpcError: Object.assign(new Error('relation missing'), { code: 'XX000' }) });
  const res = await f.send({ taskChoice: 'create' });
  assert.equal(res.statusCode, 500);
  assert.equal(f.inserted.length, 0);
});
