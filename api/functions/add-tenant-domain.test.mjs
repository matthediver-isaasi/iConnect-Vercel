import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddTenantDomainHandler } from './add-tenant-domain.js';

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createDatabase({ lookupData = null, lookupError = null, updateError = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, 'tenant');
      let mode = null;
      return {
        select() {
          mode = 'select';
          return this;
        },
        eq() {
          if (mode === 'update') return Promise.resolve({ error: updateError });
          return this;
        },
        neq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: lookupData, error: lookupError });
        },
        update(value) {
          mode = 'update';
          writes.push(value);
          return this;
        },
      };
    },
  };
}

function request() {
  return { method: 'POST', body: { domain: 'Example.org' } };
}

function dependencies(database, overrides = {}) {
  return {
    supabase: database,
    getTenantContext: async () => ({
      isAuthenticated: true,
      isSuperAdmin: true,
      tenantId: 'tenant_1',
    }),
    vercelToken: 'token',
    vercelProjectId: 'prj_target',
    vercelTeamId: undefined,
    ...overrides,
  };
}

test('add-domain handler fails closed when tenant conflict lookup errors', async () => {
  const database = createDatabase({ lookupError: new Error('database unavailable') });
  let registrations = 0;
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => {
      registrations += 1;
      return { ok: true };
    },
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(registrations, 0);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler does not save when safe registration throws', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => {
      throw new Error('provider unavailable');
    },
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler saves only after successful safe registration', async () => {
  const database = createDatabase();
  const registrations = [];
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async (config, domain) => {
      registrations.push({ config, domain });
      return { ok: true, status: 'attached' };
    },
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].domain, 'example.org');
  assert.equal(registrations[0].config.projectId, 'prj_target');
  assert.equal(database.writes.length, 1);
  assert.deepEqual(database.writes[0], { domain: 'example.org' });
  assert.deepEqual(res.body.dnsInstructions, {
    aRecord: {
      type: 'A',
      name: '@',
      value: '76.76.21.21'
    },
    cname: {
      type: 'CNAME',
      name: 'www',
      value: 'cname.vercel-dns.com'
    }
  });
});

test('add-domain handler fails closed on partial Vercel configuration', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    vercelProjectId: '',
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler explains an incorrectly configured target project', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => ({ ok: false, reason: 'target_project_mismatch' }),
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /hosting project configuration could not be verified/i);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler explains missing hosting team or token scope', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => ({
      ok: false,
      reason: 'target_domain_access_failed',
      response: { json: { error: { code: 'forbidden' } } },
    }),
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /project, team, and token permissions/i);
  assert.doesNotMatch(res.body.error, /different account/i);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler reports transient domain discovery failures', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => ({
      ok: false,
      reason: 'target_domain_discovery_failed',
      response: { json: { error: { code: 'internal_error' } } },
    }),
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /could not verify this domain right now/i);
  assert.match(res.body.error, /try again later/i);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler preserves genuine cross-project attachments', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => ({
      ok: false,
      reason: 'cross_project_conflict',
      response: { json: { error: { code: 'domain_already_in_use_by_project' } } },
    }),
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /attachment was preserved/i);
  assert.doesNotMatch(res.body.error, /could not transfer|have it moved/i);
  assert.equal(database.writes.length, 0);
});

test('add-domain handler does not suggest moving an unverified existing domain', async () => {
  const database = createDatabase();
  const handler = createAddTenantDomainHandler(dependencies(database, {
    registerDomainSafely: async () => ({
      ok: false,
      reason: 'unverified_existing_domain',
      response: { json: { error: { code: 'domain_already_exists' } } },
    }),
  }));
  const res = createResponse();

  await handler(request(), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /could not be verified/i);
  assert.match(res.body.error, /no existing attachment was changed/i);
  assert.doesNotMatch(res.body.error, /transfer|moved/i);
  assert.equal(database.writes.length, 0);
});