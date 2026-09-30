import test from 'node:test';
import assert from 'node:assert/strict';
import { formCommunicationCategoriesHandler, resolveCreationCommunicationMember } from './communication-categories.js';
import { applicantConfigurationDigest, hashApplicantToken } from '../../_lib/formApplicantContinuation.js';
import { persistFormCommunicationSubscriptions } from '../../_lib/formCommunicationSubscriptions.js';

function fixture({ mode = 'legacy_public_application', session = null, admin = false, failure, formOverrides = {} } = {}) {
  const form = {
    id: 'form', tenant_id: 'tenant', is_active: true, prefill_source: 'member',
    require_authentication: false,
    mutation_access_policy: { version: 1, mode },
    fields: [{ id: 'preferences', type: 'communication_preferences' }],
    entity_pipelines: [{ id: 'org', target_entity: 'organization', action: 'update',
      mappings: [{ source_field_id: 'name', target_type: 'core', target_field: 'phone' }] }],
    ...formOverrides,
  };
  const token = 'a'.repeat(43);
  const rows = {
    form: [form],
    member: [
      { id: 'member', tenant_id: 'tenant', organization_id: 'org', role_id: 'role', email: 'member@example.test' },
      { id: 'other', tenant_id: 'tenant', organization_id: 'org', role_id: null },
      { id: 'foreign', tenant_id: 'foreign-tenant', role_id: 'role' },
    ],
    organization: [{ id: 'org', tenant_id: 'tenant' }],
    communication_category: [
      { id: 'private', name: 'Private', description: 'Description', tenant_id: 'tenant', is_active: true, is_public: false, member_enabled: true, display_order: 1 },
      { id: 'open', name: 'Open', tenant_id: 'tenant', is_active: true, is_public: true, member_enabled: true, display_order: 2 },
      { id: 'wrong-role', tenant_id: 'tenant', is_active: true, member_enabled: true },
      { id: 'public-only', tenant_id: 'tenant', is_active: true, is_public: true, member_enabled: false },
      { id: 'inactive', tenant_id: 'tenant', is_active: false, member_enabled: true },
      { id: 'foreign-category', tenant_id: 'foreign-tenant', is_active: true },
    ],
    communication_category_role: [
      { category_id: 'private', role_id: 'role', tenant_id: 'tenant' },
      { category_id: 'wrong-role', role_id: 'wrong', tenant_id: 'tenant' },
      { category_id: 'open', role_id: 'wrong', tenant_id: 'foreign-tenant' },
    ],
    form_applicant_continuation: [{
      id: 'grant', tenant_id: 'tenant', form_id: 'form', organization_id: 'org',
      token_hash: hashApplicantToken(token), configuration_digest: applicantConfigurationDigest(form),
      expires_at: '2099-01-01T00:00:00Z', member_ids: ['member'],
      draft_token_hashes: [hashApplicantToken('draft')],
    }],
    form_draft_submission: [{
      tenant_id: 'tenant', form_id: 'form', resume_token_hash: hashApplicantToken('draft'),
      applicant_continuation_id: 'grant', expires_at: '2099-01-01T00:00:00Z',
    }],
  };
  const queries = [];
  const writes = [];
  const db = {
    from(table) {
      queries.push(table);
      const filters = [];
      let columns = '*';
      let single = false;
      const query = {
        select(value) { columns = value; return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        contains(key, values) { filters.push(row => values.every(value => row[key]?.includes(value))); return this; },
        order() { return this; },
        range() { return this; },
        maybeSingle() { single = true; return this; },
        then(resolve, reject) {
          const result = (rows[table] || []).filter(row => filters.every(filter => filter(row)))
            .map(row => columns === '*' ? row : Object.fromEntries(columns.split(',').map(key => [key.trim(), row[key.trim()]])));
          return Promise.resolve({ data: single ? result[0] || null : result,
            error: failure === table ? { message: 'unavailable' } : null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) { writes.push({ name, args }); return { error: null }; },
  };
  async function request(body = {}, { method = 'POST', access = true } = {}) {
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await formCommunicationCategoriesHandler({
      method, body: { formId: 'form', fieldId: 'preferences', memberId: 'member', ...body },
    }, res, {
      db, resolveTenant: async () => ({ id: 'tenant' }),
      getSessionMember: async () => session,
      getTenantContext: async () => admin ? { tenantId: 'tenant' } : null,
      hasAdminAccess: async () => admin,
      resolveAccess: async () => ({ allowed: access, requires_authentication: !access }),
    });
    return res;
  }
  return { db, form, token, rows, queries, writes, request };
}

test('legacy admission returns minimal eligible member categories without widening anonymous discovery', async () => {
  const f = fixture();
  const res = await f.request({ applicantContinuationToken: 'expired', draftToken: 'stale' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map(row => row.id), ['private', 'open']);
  assert.deepEqual(Object.keys(res.body[0]), ['id', 'name', 'description', 'is_public', 'member_enabled', 'role_ids']);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.queries.includes('form_applicant_continuation'), false);
  assert.equal(f.writes.length, 0);
});

test('persisted allowlist, not request allowlist or role, limits metadata', async () => {
  const f = fixture();
  f.form.fields[0].allowed_category_ids = ['private', 'wrong-role'];
  const res = await f.request({ allowed_category_ids: ['open'], roleId: 'wrong' });
  assert.deepEqual(res.body.map(row => row.id), ['private']);
});

test('roleless members see only member-enabled unrestricted categories', async () => {
  const f = fixture();
  const res = await f.request({ memberId: 'other', roleId: 'role' });
  assert.deepEqual(res.body.map(row => row.id), ['open']);
});

for (const mode of ['legacy_public_application', 'applicant_continuation', 'secure']) {
  test(`${mode} rejects foreign member references before category discovery`, async () => {
    const f = fixture({ mode });
    const res = await f.request({ memberId: 'foreign', applicantContinuationToken: f.token });
    assert.equal(res.statusCode, 403);
    assert.equal(f.queries.includes('communication_category'), false);
  });
}

test('ordinary secure forms reject bare member IDs and foreign sessions but accept verified self', async () => {
  for (const session of [null, { id: 'member', tenant_id: 'foreign-tenant' }, { id: 'other', tenant_id: 'tenant' }]) {
    const f = fixture({ mode: 'secure', session });
    assert.equal((await f.request()).statusCode, 403);
    assert.equal(f.queries.includes('communication_category'), false);
  }
  const f = fixture({ mode: 'secure', session: { id: 'member', tenant_id: 'tenant' } });
  assert.equal((await f.request()).statusCode, 200);
});

test('secure applicant token and independently associated draft authorize only immutable current member scope', async () => {
  const f = fixture({ mode: 'applicant_continuation' });
  assert.equal((await f.request()).statusCode, 403);
  assert.equal((await f.request({ applicantContinuationToken: f.token })).statusCode, 200);
  assert.equal((await f.request({ draftToken: 'draft' })).statusCode, 200);
  assert.equal((await f.request({ memberId: 'other', applicantContinuationToken: f.token })).statusCode, 403);
  f.rows.member[0].organization_id = 'moved';
  assert.equal((await f.request({ applicantContinuationToken: f.token })).statusCode, 403);
});

test('expired, revoked, drifted and unassociated grants never disclose private categories', async () => {
  for (const patch of [
    { expires_at: '2000-01-01' }, { revoked_at: '2025-01-01' },
    { configuration_digest: 'changed' }, { draft_token_hashes: [] },
  ]) {
    const f = fixture({ mode: 'applicant_continuation' });
    Object.assign(f.rows.form_applicant_continuation[0], patch);
    assert.equal((await f.request({ draftToken: 'draft' })).statusCode, 403);
    assert.equal(f.queries.includes('communication_category'), false);
  }
});

test('login requirement and form access policy cannot be bypassed by legacy mode', async () => {
  const f = fixture({ formOverrides: { require_authentication: true } });
  assert.equal((await f.request()).statusCode, 403);
  assert.equal((await fixture().request({}, { access: false })).statusCode, 403);
});

test('unavailable forms, unknown fields and malformed requests fail explicitly', async () => {
  for (const formOverrides of [
    { is_active: false }, { deactivate_at: '2000-01-01' }, { form_type: 'survey' }, { tenant_id: 'other' },
  ]) assert.equal((await fixture({ formOverrides }).request()).statusCode, 404);
  assert.equal((await fixture().request({ fieldId: 'missing' })).statusCode, 404);
  assert.equal((await fixture().request({ memberId: {} })).statusCode, 400);
  assert.equal((await fixture().request({}, { method: 'GET' })).statusCode, 405);
});

for (const table of ['form', 'member', 'communication_category', 'communication_category_role']) {
  test(`${table} lookup failure is explicit, never an empty success`, async () => {
    assert.equal((await fixture({ failure: table }).request()).statusCode, 500);
  });
}

test('discovered selections agree with real subscription persistence eligibility', async () => {
  const f = fixture();
  const res = await f.request();
  const selections = Object.fromEntries(res.body.map(row => [row.id, true]));
  const result = await persistFormCommunicationSubscriptions({
    database: f.db, tenantId: 'tenant', form: f.form,
    submissionData: { preferences: selections }, resolvedMemberId: 'member',
  });
  assert.deepEqual(result.selections.map(row => row.category_id), ['private', 'open']);
  await assert.rejects(() => persistFormCommunicationSubscriptions({
    database: f.db, tenantId: 'tenant', form: f.form,
    submissionData: { preferences: { 'wrong-role': true } }, resolvedMemberId: 'member',
  }), error => error.code === 'COMMUNICATION_CATEGORY_ROLE_FORBIDDEN');
});

function creationFixture(options = {}, pipeline = {}) {
  return fixture({
    ...options,
    formOverrides: {
      mutation_access_policy: { version: 1, mode: 'public_member_signup' },
      fields: [
        { id: 'preferences', type: 'communication_preferences' },
        { id: 'kind', type: 'select', options: ['Member', 'Visitor'] },
      ],
      entity_pipelines: { members: [{
        id: 'primary', isPrimary: true, role_id: 'role',
        mappings: [{ target_type: 'core', target_field: 'email', source_field_id: 'email' }],
        ...pipeline,
      }] },
      ...options.formOverrides,
    },
  });
}

test('anonymous primary member creation can discover private fixed-role categories without member lookup', async () => {
  const f = creationFixture();
  const res = await f.request({ memberId: null, roleId: 'wrong', entity_pipelines: { members: [] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map(row => row.id), ['private', 'open']);
  assert.equal(f.queries.includes('member'), false);
  assert.equal(f.writes.length, 0);
});

test('roleless creation and explicit clear retain unrestricted member categories', async () => {
  for (const role_id of [null, '__clear__', '__keep__']) {
    const f = creationFixture({}, { role_id });
    const res = await f.request({ memberId: undefined });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.map(row => row.id), ['open']);
  }
});

test('new-member role derives only from saved answer map, including fallback and clear', async () => {
  const f = creationFixture({}, { role_assignment: {
    mode: 'from_field', source_field_id: 'kind', value_to_role_id: { Member: 'role', Visitor: '__clear__' },
    fallback: 'none',
  } });
  for (const [answer, ids] of [['Member', ['private', 'open']], ['Visitor', ['open']], ['role', ['open']], ['', ['open']]]) {
    const res = await f.request({ memberId: null, sourceAnswers: { kind: answer }, roleId: 'role' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.map(row => row.id), ids);
  }
  assert.equal((await f.request({ memberId: null, sourceAnswers: { kind: ['Member'] } })).statusCode, 400);
});

test('creation fallback uses persisted form and tenant defaults, not fixed role under dynamic default fallback', async () => {
  const f = creationFixture({ formOverrides: { default_member_role_id: 'role' } }, {
    role_id: 'wrong', role_assignment: { mode: 'from_field', source_field_id: 'kind', fallback: 'default' },
  });
  assert.deepEqual((await f.request({ memberId: null })).body.map(row => row.id), ['private', 'open']);
  f.form.default_member_role_id = null;
  f.rows.role = [{ id: 'role', tenant_id: 'tenant', is_default: true }];
  assert.deepEqual((await f.request({ memberId: null })).body.map(row => row.id), ['private', 'open']);
});

test('anonymous discovery requires persisted primary creation config, never request config', async () => {
  for (const entity_pipelines of [null, {}, { members: [] }, { members: [{ role_id: 'role' }] }]) {
    const f = creationFixture({ formOverrides: { entity_pipelines } });
    const res = await f.request({ memberId: null, entity_pipelines: { members: [{ isPrimary: true, role_id: 'role' }] } });
    assert.equal(res.statusCode, 403);
    assert.equal(f.queries.includes('communication_category'), false);
  }
});

test('creation still enforces field allowlist, secure admission, login and form access', async () => {
  const f = creationFixture();
  f.form.fields[0].allowed_category_ids = ['private'];
  assert.deepEqual((await f.request({ memberId: null })).body.map(row => row.id), ['private']);
  for (const formOverrides of [
    { require_authentication: true },
    { mutation_access_policy: { version: 1, mode: 'authenticated_owner' } },
    { mutation_access_policy: { version: 1, mode: 'applicant_continuation' } },
  ]) {
    const secure = creationFixture({ formOverrides });
    assert.equal((await secure.request({ memberId: null })).statusCode, 403);
    assert.equal(secure.queries.includes('communication_category'), false);
  }
  assert.equal((await f.request({ memberId: null }, { access: false })).statusCode, 403);
});

test('new-member discovery agrees with submission role resolver and persistence after creation', async () => {
  const f = creationFixture({}, {
    role_assignment: { mode: 'from_field', source_field_id: 'kind', value_to_role_id: { Member: 'role' } },
  });
  const sourceAnswers = { kind: 'Member' };
  const member = await resolveCreationCommunicationMember({ db: f.db, form: f.form, sourceAnswers });
  f.rows.member[0].role_id = member.role_id;
  const res = await f.request({ memberId: null, sourceAnswers });
  const result = await persistFormCommunicationSubscriptions({
    database: f.db, tenantId: 'tenant', form: f.form, resolvedMemberId: 'member',
    submissionData: { preferences: Object.fromEntries(res.body.map(row => [row.id, true])) },
  });
  assert.deepEqual(result.selections.map(row => row.category_id), ['private', 'open']);
});