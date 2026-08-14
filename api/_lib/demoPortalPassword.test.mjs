// Tests for the demo tenant portal-password feature (Task #3548): the
// platform console lists a demo tenant's login personas and can set/reset
// their shared portal password. Guards tenant scoping (never touches other
// tenants' or non-seeded members) and the credential-store precedence the
// login flow uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const engineSrc = fs.readFileSync(new URL('../../demo-seeds/engine.mjs', import.meta.url), 'utf8');
const operateSrc = fs.readFileSync(new URL('../platform/demo-tenants/operate.js', import.meta.url), 'utf8');
const indexSrc = fs.readFileSync(new URL('../platform/demo-tenants/index.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Behavioral: persona list derived from the definition, not hardcoded UI data
// ---------------------------------------------------------------------------
test('aesp definition exposes login personas with owner, admins and login members', async () => {
  const { default: definition } = await import('../../demo-seeds/aesp/definition.mjs');
  const personas = definition.loginPersonas();
  assert.ok(personas.length >= 5, 'expects owner + 2 admins + login member personas');
  const emails = personas.map((p) => p.email);
  // Owner comes from the tenant definition itself.
  assert.ok(emails.includes(definition.tenant.adminEmail.toLowerCase()));
  // Known login personas (login: true in PERSONAS) are present…
  for (const e of ['sarah.mitchell@aesp.example.com', 'james.walker@aesp.example.com', 'aisha.rahman@aesp.example.com', 'daniel.brooks@aesp.example.com']) {
    assert.ok(emails.includes(e), `missing login persona ${e}`);
  }
  // …and non-login personas are NOT (they have no credentials to reset).
  for (const e of ['chloe.evans@aesp.example.com', 'peter.langford@aesp.example.com', 'emily.foster@aesp.example.com']) {
    assert.ok(!emails.includes(e), `non-login persona ${e} must not be listed`);
  }
  // Every persona row is complete enough for the console UI.
  for (const p of personas) {
    assert.ok(p.name && p.email && p.role && p.kind, `incomplete persona ${JSON.stringify(p)}`);
    assert.match(p.email, /@aesp\.example\.com$/);
  }
});

// ---------------------------------------------------------------------------
// Engine: setDemoPortalPassword scoping and credential-store coverage
// ---------------------------------------------------------------------------
const fnAt = engineSrc.indexOf('export async function setDemoPortalPassword');
assert.ok(fnAt > -1, 'setDemoPortalPassword must exist');
const fnSrc = engineSrc.slice(fnAt, engineSrc.indexOf('export async function demoTenantStatus', fnAt));

test('password reset is scoped to the demo tenant and its seeded members only', () => {
  // Demo-ownership assertion prevents mutating a real tenant sharing the slug.
  assert.match(fnSrc, /assertDemoOwnership\(sb, tenant, definition\)/);
  // Member lookup is tenant-scoped AND restricted to seeded (is_sample) rows
  // matched by the definition's persona emails.
  assert.match(fnSrc, /\.eq\('tenant_id', tenantId\)\s*\n\s*\.eq\('is_sample', true\)\s*\n\s*\.in\('email', emails\)/);
  // tenant_membership_credentials writes are pinned to this tenant.
  const tmcAt = fnSrc.indexOf("from('tenant_membership_credentials')");
  const tmcScope = fnSrc.slice(tmcAt, tmcAt + 500);
  assert.match(tmcScope, /tenant_id: tenantId/);
});

test('reset updates every credential store in login precedence order', () => {
  // 1. tenant_membership_credentials is UPSERTED (not update-only): the
  // login flow checks it first and falls back to the shared tenant_identity
  // hash before member_credentials, so the per-tenant row must exist or a
  // stale identity hash would shadow the new password.
  assert.match(fnSrc, /from\('tenant_membership_credentials'\)\s*\n?\s*\.upsert\(/,
    'must atomically upsert the (identity, tenant) credential row');
  assert.match(fnSrc, /onConflict: 'identity_id,tenant_id'/);
  assert.match(fnSrc, /throw new Error\(`tenant credentials upsert failed/,
    'a failed per-tenant credential write must fail the operation');
  // 2. tenant_identity.password_hash is NEVER written — identities are
  // cross-tenant; mutating the shared hash could change a real user's
  // password in another tenant.
  assert.ok(!/from\('tenant_identity'\)\s*\n?\s*\.update\(/.test(fnSrc),
    'must never update the cross-tenant tenant_identity hash');
  // 3. member_credentials upserted with lockout state cleared.
  assert.match(fnSrc, /member_credentials/);
  assert.match(fnSrc, /failed_login_attempts: 0/);
  assert.match(fnSrc, /locked_until: null/);
  // Only bcrypt hashes are persisted; the plaintext is returned once.
  assert.match(fnSrc, /bcrypt\.hash\(plain, 10\)/);
  assert.match(fnSrc, /password: plain/);
  // Minimum length enforced even for caller-supplied passwords.
  assert.match(fnSrc, /plain\.length < 8/);
});

// ---------------------------------------------------------------------------
// Operate endpoint: action wiring and platform-owner gating
// ---------------------------------------------------------------------------
test("operate endpoint supports 'set-password' behind platform-owner auth", () => {
  assert.match(operateSrc, /'seed', 'reset', 'delete', 'set-password'/);
  // Auth check precedes action handling.
  const authAt = operateSrc.indexOf('getSessionPlatformOwner');
  const actionAt = operateSrc.indexOf("action === 'set-password'");
  assert.ok(authAt > -1 && actionAt > authAt, 'platform-owner auth must precede the action');
  // Short caller-supplied passwords are rejected up front.
  assert.match(operateSrc, /trim\(\)\.length < 8/);
  assert.match(operateSrc, /setDemoPortalPassword\(definition, \{/);
  // Destructive confirm requirement stays limited to reset/delete.
  assert.match(operateSrc, /\(action === 'reset' \|\| action === 'delete'\) && confirmSlug !== definition\.tenant\.slug/);
});

test('console list endpoint returns the definition personas', () => {
  assert.match(indexSrc, /loginPersonas: typeof def\.loginPersonas === 'function' \? def\.loginPersonas\(\) : \[\]/);
});

// ---------------------------------------------------------------------------
// Behavioral: mocked supabase client driving setDemoPortalPassword through
// the precedence-critical states.
// ---------------------------------------------------------------------------
const TENANT_ID = 'tenant-1';

/**
 * Minimal supabase-js mock. `state` controls fixture rows;
 * `writes` records every mutating call.
 */
function makeMockSb(state) {
  const writes = [];
  let insertSeq = 0;
  const from = (table) => {
    const filters = {};
    let op = 'select';
    let payload = null;
    let upsertOpts = null;
    const builder = {
      select() { return builder; },
      update(row) { op = 'update'; payload = row; return builder; },
      insert(row) {
        op = 'insert'; payload = row;
        const p = resolve();
        // Support insert(...).select(...).single() (member-create repair path)
        p.select = () => ({
          single: async () => {
            const r = await p;
            if (r.error) return r;
            return { data: { id: `gen-${table}-${++insertSeq}` }, error: null };
          },
        });
        return p;
      },
      upsert(row, opts) { op = 'upsert'; payload = row; upsertOpts = opts; return resolve(); },
      eq(k, v) { filters[k] = v; return builder; },
      ilike(k, v) { filters[`ilike:${k}`] = v; return builder; },
      in(k, v) { filters[k] = v; return builder; },
      is(k, v) { filters[`is:${k}`] = v; return builder; },
      limit() { return builder; },
      maybeSingle() { return resolve(true); },
      then(res, rej) { return resolve().then(res, rej); }, // awaited select/update chains
    };
    async function resolve(single = false) {
      if (op !== 'select') {
        writes.push({ table, op, payload, filters: { ...filters }, upsertOpts });
        const fail = state.failWrites?.[table];
        if (fail) return { error: { message: fail } };
        // Compare-and-set updates (…​.is('organization_id', null).select('id')):
        // honor the write-time condition against the CURRENT stored row, so
        // races between read and write can be simulated.
        if (table === 'member' && op === 'update' && 'is:organization_id' in filters) {
          const row = (state.members || []).find((m) => m.id === filters.id);
          const matches = row && (row.organization_id ?? null) === filters['is:organization_id'];
          if (matches) row.organization_id = payload.organization_id;
          return { data: matches ? [{ id: row.id }] : [], error: null };
        }
        return { error: null, data: null };
      }
      if (table === 'tenant') return { data: state.tenant, error: null };
      if (table === 'system_settings') {
        if (filters.setting_key === 'role_segmentation_field_id' && filters.tenant_id === TENANT_ID && state.segmentationFieldId) {
          return { data: { setting_value: state.segmentationFieldId }, error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'member') {
        if (typeof filters.email === 'string') {
          const row = (state.members || []).find((m) => m.email === filters.email) || null;
          return { data: single ? row : (row ? [row] : []), error: null };
        }
        if (typeof filters.id === 'string') {
          let row = (state.members || []).find((m) => m.id === filters.id) || null;
          // Race simulation: reads report no organisation while the stored
          // row (checked by the CAS write) already has one.
          if (row && state.readOrgAsNull) row = { ...row, organization_id: null };
          return { data: single ? row : (row ? [row] : []), error: null };
        }
        return { data: state.members, error: null };
      }
      if (table === 'role') {
        let rows = state.roles || [];
        // Honor tenant scoping — a role from another tenant must never match.
        if (filters.tenant_id != null) rows = rows.filter((r) => r.tenant_id === filters.tenant_id);
        if (typeof filters.id === 'string') rows = rows.filter((r) => r.id === filters.id);
        if (filters.is_system != null) rows = rows.filter((r) => !!r.is_system === filters.is_system);
        if (filters.is_default != null) rows = rows.filter((r) => !!r.is_default === filters.is_default);
        if (filters['ilike:name']) rows = rows.filter((r) => r.name.toLowerCase() === filters['ilike:name'].toLowerCase());
        return { data: single ? (rows[0] || null) : rows, error: null };
      }
      if (table === 'organization') {
        let rows = state.orgs || [];
        if (filters.tenant_id != null) rows = rows.filter((o) => o.tenant_id === filters.tenant_id);
        if (filters.is_primary != null) rows = rows.filter((o) => !!o.is_primary === filters.is_primary);
        if (typeof filters.id === 'string') rows = rows.filter((o) => o.id === filters.id);
        return { data: single ? (rows[0] || null) : rows, error: null };
      }
      if (table === 'member_credentials') {
        const row = state.memberCreds?.find((c) => c.email === filters.email) || null;
        return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
      }
      if (table === 'tenant_identity') {
        const row = state.identities?.find((i) => i.email === filters.email) || null;
        return { data: row, error: null };
      }
      if (table === 'tenant_membership') {
        const rows = (state.tenantMemberships || []).filter(
          (r) => (!filters.identity_id || r.identity_id === filters.identity_id)
            && (!filters.tenant_id || r.tenant_id === filters.tenant_id)
        );
        return { data: single ? (rows[0] || null) : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    }
    return builder;
  };
  return { sb: { from }, writes };
}

const mockDefinition = {
  key: 'mockdemo',
  tenant: { slug: 'mockdemo', adminEmail: 'owner@mock.example.com' },
  loginPersonas: () => [
    { name: 'Owner', email: 'owner@mock.example.com', role: 'Owner', kind: 'owner' },
    { name: 'Member', email: 'member@mock.example.com', role: 'Member', kind: 'member' },
  ],
};
const mockTenant = { id: TENANT_ID, slug: 'mockdemo', settings: { demo_seed: { key: 'mockdemo' } } };

async function importEngine() {
  return import('../../demo-seeds/engine.mjs');
}

test('stale shared identity without a per-tenant credential row gets one upserted', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb, writes } = makeMockSb({
    tenant: mockTenant,
    members: [
      { id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner' },
      { id: 'm-member', email: 'member@mock.example.com', identity_id: null },
    ],
    // member has a stale identity (found by email) but NO tmc row
    identities: [{ id: 'ident-member', email: 'member@mock.example.com', password_hash: 'stale' }],
  });
  const result = await setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.password, 'demo-pass-123');
  assert.equal(result.updated, 2);
  const tmcWrites = writes.filter((w) => w.table === 'tenant_membership_credentials');
  assert.equal(tmcWrites.length, 2, 'both identity-backed personas get a per-tenant credential row');
  for (const w of tmcWrites) {
    assert.equal(w.op, 'upsert');
    assert.equal(w.upsertOpts.onConflict, 'identity_id,tenant_id');
    assert.equal(w.payload.tenant_id, TENANT_ID);
    assert.ok(w.payload.password_hash?.startsWith('$2'), 'bcrypt hash stored');
  }
  assert.ok(tmcWrites.some((w) => w.payload.identity_id === 'ident-member'), 'stale identity gets a row');
  // The shared identity hash itself is never mutated.
  assert.ok(!writes.some((w) => w.table === 'tenant_identity'), 'tenant_identity must never be written');
  // member_credentials written for both personas.
  assert.equal(writes.filter((w) => w.table === 'member_credentials').length, 2);
});

test('failed per-tenant credential write fails the whole operation — no plaintext returned', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb } = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner' }],
    failWrites: { tenant_membership_credentials: 'unique violation' },
  });
  await assert.rejects(
    () => setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} }),
    /tenant credentials upsert failed/,
  );
});

test('failed member_credentials write fails the operation', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb } = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-member', email: 'member@mock.example.com', identity_id: null }],
    failWrites: { member_credentials: 'column drift' },
  });
  await assert.rejects(
    () => setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} }),
    /member_credentials insert failed/,
  );
});

test('no seeded persona members → operation refuses', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb } = makeMockSb({ tenant: mockTenant, members: [] });
  await assert.rejects(
    () => setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} }),
    /No seeded persona members/,
  );
});

// ---------------------------------------------------------------------------
// Identity-backed owner repair (Task #3551): a persona with no seeded member
// row (e.g. a provision-time owner existing only as tenant_identity) must be
// repaired, not silently skipped.
// ---------------------------------------------------------------------------
test('owner persona with only a tenant_identity is repaired: member + membership + TMC created, tenant_identity untouched', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb, writes } = makeMockSb({
    tenant: mockTenant,
    // Only the member persona has a seeded member row — the owner does not.
    members: [{ id: 'm-member', email: 'member@mock.example.com', identity_id: null }],
    identities: [{ id: 'ident-owner', email: 'owner@mock.example.com', password_hash: 'stale-seed-hash' }],
    tenantMemberships: [],
  });
  const result = await setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.updated, 2);
  assert.equal(result.repaired, 1);
  const owner = result.personas.find((p) => p.email === 'owner@mock.example.com');
  assert.equal(owner.outcome, 'repaired');
  assert.equal(owner.found, true);
  assert.equal(result.personas.find((p) => p.email === 'member@mock.example.com').outcome, 'updated');
  // Sample member row created, strictly tenant-scoped and identity-linked.
  const memberInsert = writes.find((w) => w.table === 'member' && w.op === 'insert');
  assert.ok(memberInsert, 'owner member row must be created');
  assert.equal(memberInsert.payload.tenant_id, TENANT_ID);
  assert.equal(memberInsert.payload.is_sample, true);
  assert.equal(memberInsert.payload.identity_id, 'ident-owner');
  assert.equal(memberInsert.payload.email, 'owner@mock.example.com');
  // tenant_membership linkage created for the login resolver.
  const tmInsert = writes.find((w) => w.table === 'tenant_membership' && w.op === 'insert');
  assert.ok(tmInsert, 'tenant_membership row must be created');
  assert.equal(tmInsert.payload.tenant_id, TENANT_ID);
  assert.equal(tmInsert.payload.identity_id, 'ident-owner');
  assert.equal(tmInsert.payload.role, 'owner');
  assert.ok(tmInsert.payload.member_id, 'membership must point at the created member');
  // Per-tenant credential row upserted with the new hash.
  const tmc = writes.find((w) => w.table === 'tenant_membership_credentials' && w.payload.identity_id === 'ident-owner');
  assert.ok(tmc && tmc.op === 'upsert');
  assert.equal(tmc.payload.tenant_id, TENANT_ID);
  assert.ok(tmc.payload.password_hash?.startsWith('$2'));
  // The cross-tenant identity hash is never written.
  assert.ok(!writes.some((w) => w.table === 'tenant_identity'), 'tenant_identity must never be written');
});

test('existing membership without member_id is relinked instead of duplicated', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb, writes } = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-member', email: 'member@mock.example.com', identity_id: null }],
    identities: [{ id: 'ident-owner', email: 'owner@mock.example.com' }],
    tenantMemberships: [{ id: 'tm-1', identity_id: 'ident-owner', tenant_id: TENANT_ID, member_id: null }],
  });
  await setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} });
  const tmWrites = writes.filter((w) => w.table === 'tenant_membership');
  assert.equal(tmWrites.length, 1);
  assert.equal(tmWrites[0].op, 'update');
  assert.ok(tmWrites[0].payload.member_id, 'existing membership relinked to the member row');
  assert.equal(tmWrites[0].filters.tenant_id, TENANT_ID, 'membership update pinned to the demo tenant');
});

test('persona with no member row and no identity is skipped with a reason; others still succeed', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb, writes } = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-member', email: 'member@mock.example.com', identity_id: null }],
    identities: [],
  });
  const result = await setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.updated, 1);
  const owner = result.personas.find((p) => p.email === 'owner@mock.example.com');
  assert.equal(owner.outcome, 'skipped');
  assert.equal(owner.found, false);
  assert.match(owner.reason, /no seeded member row and no tenant_identity/);
  // No repair writes were attempted for the unresolvable persona.
  assert.ok(!writes.some((w) => w.table === 'member' && w.op === 'insert'));
  assert.ok(!writes.some((w) => w.table === 'tenant_membership'));
});

test('per-persona failure is reported without hiding other personas\u2019 success', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const { sb } = makeMockSb({
    tenant: mockTenant,
    members: [
      { id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner' },
      { id: 'm-member', email: 'member@mock.example.com', identity_id: null },
    ],
    identities: [],
    // Only the owner touches tenant_membership_credentials (has an identity),
    // so this failure is persona-specific.
    failWrites: { tenant_membership_credentials: 'unique violation' },
  });
  const result = await setDemoPortalPassword(mockDefinition, { sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.updated, 1);
  const owner = result.personas.find((p) => p.email === 'owner@mock.example.com');
  assert.equal(owner.outcome, 'failed');
  assert.match(owner.reason, /tenant credentials upsert failed/);
  assert.equal(result.personas.find((p) => p.email === 'member@mock.example.com').outcome, 'updated');
});

test('console UI surfaces skipped/failed personas', () => {
  const uiSrc = fs.readFileSync(new URL('../../client/src/pages/platform/DemoTenants.jsx', import.meta.url), 'utf8');
  assert.match(uiSrc, /outcome === 'skipped' \|\| p\.outcome === 'failed'/);
  assert.match(uiSrc, /NOT updated/);
});

// ---------------------------------------------------------------------------
// Seed-time owner creation (Task #3552): a fresh seed must create/repair the
// owner's member row, tenant_membership linkage and credential rows itself —
// via the SAME shared helpers as the password-reset repair path — so the
// owner never needs a password reset to become resolvable.
// ---------------------------------------------------------------------------
test('seed owner block reuses the shared identity-persona repair helpers', () => {
  const defSrc = fs.readFileSync(new URL('../../demo-seeds/aesp/definition.mjs', import.meta.url), 'utf8');
  assert.match(defSrc, /resolveDemoIdentityId\(sb, adminEmail\)/,
    'seed must resolve the owner identity by email');
  assert.match(defSrc, /repairDemoIdentityPersona\(\{\s*\n?\s*sb, tenantId, persona: ownerPersona, identityId, passwordHash/,
    'seed must create/repair the owner via the shared engine helper');
  // The engine exports the shared helpers the reset path also uses.
  assert.match(engineSrc, /export async function repairDemoIdentityPersona/);
  assert.match(engineSrc, /export async function writeDemoPersonaCredentials/);
  assert.match(engineSrc, /export async function resolveDemoIdentityId/);
  // The old update-only owner block (member row only touched if it exists,
  // never created) must be gone.
  assert.ok(!/if \(adminMember\)/.test(defSrc), 'owner block must not be update-only anymore');
});

test('repairDemoIdentityPersona creates member + membership + credentials for a fresh-seed owner', async () => {
  const { repairDemoIdentityPersona } = await importEngine();
  const { sb, writes } = makeMockSb({
    tenant: mockTenant,
    members: [],
    identities: [{ id: 'ident-owner', email: 'owner@mock.example.com' }],
    tenantMemberships: [],
  });
  const memberId = await repairDemoIdentityPersona({
    sb, tenantId: TENANT_ID,
    persona: { name: 'Hannah Clarke', email: 'owner@mock.example.com', role: 'Owner', kind: 'owner' },
    identityId: 'ident-owner',
    passwordHash: '$2a$10$fakehashfakehashfakehash',
    memberPatch: { job_title: 'Chief Executive' },
  });
  assert.ok(memberId, 'returns the created member id');
  const memberInsert = writes.find((w) => w.table === 'member' && w.op === 'insert');
  assert.equal(memberInsert.payload.is_sample, true);
  assert.equal(memberInsert.payload.identity_id, 'ident-owner');
  assert.equal(memberInsert.payload.job_title, 'Chief Executive');
  assert.equal(memberInsert.payload.first_name, 'Hannah');
  assert.equal(memberInsert.payload.last_name, 'Clarke');
  const tmInsert = writes.find((w) => w.table === 'tenant_membership' && w.op === 'insert');
  assert.equal(tmInsert.payload.role, 'owner');
  assert.equal(tmInsert.payload.member_id, memberId);
  assert.ok(writes.some((w) => w.table === 'member_credentials'));
  assert.ok(writes.some((w) => w.table === 'tenant_membership_credentials' && w.op === 'upsert'));
});

test('repairDemoIdentityPersona with null identity still creates member + member_credentials, skips identity-keyed rows', async () => {
  const { repairDemoIdentityPersona } = await importEngine();
  const { sb, writes } = makeMockSb({ tenant: mockTenant, members: [], identities: [] });
  const memberId = await repairDemoIdentityPersona({
    sb, tenantId: TENANT_ID,
    persona: { name: 'Hannah Clarke', email: 'owner@mock.example.com', role: 'Owner', kind: 'owner' },
    identityId: null,
    passwordHash: '$2a$10$fakehashfakehashfakehash',
  });
  assert.ok(memberId);
  const memberInsert = writes.find((w) => w.table === 'member' && w.op === 'insert');
  assert.ok(memberInsert && !('identity_id' in memberInsert.payload), 'no identity linkage written');
  assert.ok(!writes.some((w) => w.table === 'tenant_membership'));
  assert.ok(!writes.some((w) => w.table === 'tenant_membership_credentials'));
  assert.ok(writes.some((w) => w.table === 'member_credentials'));
});

// ---------------------------------------------------------------------------
// Owner Super Admin role (Task #3557): the demo owner is assigned the
// tenant's platform-provisioned system "Super Admin" role — never a newly
// created one — only when her current role is empty or the tenant default.
// ---------------------------------------------------------------------------
const SUPER_ROLE = { id: 'role-super', name: 'Super Admin', is_system: true, is_default: false, tenant_id: TENANT_ID };
const DEFAULT_ROLE = { id: 'role-member', name: 'Member', is_system: false, is_default: true, tenant_id: TENANT_ID };
const SCOPED_ROLE = { id: 'role-scoped', name: 'Membership Manager', is_system: false, is_default: false, tenant_id: TENANT_ID };
const OTHER_TENANT_SUPER = { id: 'role-super-other', name: 'Super Admin', is_system: true, is_default: false, tenant_id: 'tenant-other' };

test('resolveDemoSuperAdminRoleId finds exactly one tenant-scoped system role, never creates one', async () => {
  const { resolveDemoSuperAdminRoleId } = await importEngine();
  // Another tenant's Super Admin must not satisfy (or duplicate) the lookup.
  const { sb, writes } = makeMockSb({ roles: [DEFAULT_ROLE, SUPER_ROLE, OTHER_TENANT_SUPER] });
  assert.equal(await resolveDemoSuperAdminRoleId(sb, TENANT_ID), 'role-super');
  assert.equal(writes.length, 0, 'lookup only — no writes');
  // Missing role → loud failure, still no role creation.
  const empty = makeMockSb({ roles: [DEFAULT_ROLE, OTHER_TENANT_SUPER] });
  await assert.rejects(() => resolveDemoSuperAdminRoleId(empty.sb, TENANT_ID), /Super Admin.*not found/s);
  assert.equal(empty.writes.length, 0);
  // Duplicates → loud failure instead of an arbitrary authorization pick.
  const dup = makeMockSb({ roles: [SUPER_ROLE, { ...SUPER_ROLE, id: 'role-super-2' }] });
  await assert.rejects(() => resolveDemoSuperAdminRoleId(dup.sb, TENANT_ID), /Multiple system "Super Admin" roles/);
  assert.equal(dup.writes.length, 0);
});

test('owner grant matrix: only an EMPTY role is upgraded — any existing role (even the default) is kept', async () => {
  const { applyDemoOwnerAdminRole } = await importEngine();
  const cases = [
    // [current role_id, expect grant]
    [null, true],
    // role_id has no provenance: even the tenant default could be a
    // deliberate admin assignment, so replacing it would be a silent
    // privilege escalation. It must be kept.
    [DEFAULT_ROLE.id, false],
    [SCOPED_ROLE.id, false],
    [SUPER_ROLE.id, true], // already on Super Admin — reported granted, no write
  ];
  for (const [roleId, expectGrant] of cases) {
    const { sb, writes } = makeMockSb({
      members: [{ id: 'm-owner', email: 'owner@mock.example.com', role_id: roleId }],
      roles: [DEFAULT_ROLE, SUPER_ROLE, SCOPED_ROLE],
    });
    const granted = await applyDemoOwnerAdminRole({ sb, tenantId: TENANT_ID, memberId: 'm-owner', roleId: SUPER_ROLE.id, log: () => {} });
    assert.equal(granted, expectGrant, `role_id=${roleId}`);
    const upd = writes.find((w) => w.table === 'member' && w.op === 'update');
    if (roleId === null) {
      assert.equal(upd.payload.role_id, SUPER_ROLE.id);
      assert.equal(upd.filters.tenant_id, TENANT_ID, 'update pinned to the demo tenant');
    } else {
      assert.ok(!upd, 'existing role must never be replaced');
    }
  }
});

test('deliberately assigned sole-default role survives both seed repair and password reset', async () => {
  const { setDemoPortalPassword, applyDemoOwnerAdminRole, resolveDemoSuperAdminRoleId } = await importEngine();
  const state = {
    tenant: mockTenant,
    members: [{ id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner', role_id: DEFAULT_ROLE.id }],
    roles: [DEFAULT_ROLE, SUPER_ROLE],
  };
  // Password reset path: owner stays on the default role.
  const reset = makeMockSb(state);
  await setDemoPortalPassword(mockDefinition, { sb: reset.sb, password: 'demo-pass-123', log: () => {} });
  assert.ok(!reset.writes.some((w) => w.table === 'member' && w.op === 'update' && w.payload.role_id),
    'reset must not change the owner role');
  // Seed path uses the same helper pair — same outcome.
  const seed = makeMockSb(state);
  const roleId = await resolveDemoSuperAdminRoleId(seed.sb, TENANT_ID);
  const granted = await applyDemoOwnerAdminRole({ sb: seed.sb, tenantId: TENANT_ID, memberId: 'm-owner', roleId, log: () => {} });
  assert.equal(granted, false);
  assert.ok(!seed.writes.some((w) => w.table === 'member' && w.op === 'update'), 'seed must not change the owner role');
});

test('password reset grants the owner Super Admin but stays best-effort when the role is missing', async () => {
  const { setDemoPortalPassword } = await importEngine();
  // With the system role present, the owner's null role is upgraded.
  const withRole = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner', role_id: null }],
    roles: [DEFAULT_ROLE, SUPER_ROLE],
  });
  await setDemoPortalPassword(mockDefinition, { sb: withRole.sb, password: 'demo-pass-123', log: () => {} });
  const upd = withRole.writes.find((w) => w.table === 'member' && w.op === 'update' && w.payload.role_id);
  assert.ok(upd && upd.payload.role_id === SUPER_ROLE.id, 'owner upgraded to Super Admin during reset');
  // Without the system role the reset still succeeds (warning only).
  const noRole = makeMockSb({
    tenant: mockTenant,
    members: [{ id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner', role_id: null }],
    roles: [DEFAULT_ROLE],
  });
  const result = await setDemoPortalPassword(mockDefinition, { sb: noRole.sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.updated, 1, 'reset must not fail because the role is missing');
});

test('seed owner block assigns the system Super Admin role', () => {
  const defSrc = fs.readFileSync(new URL('../../demo-seeds/aesp/definition.mjs', import.meta.url), 'utf8');
  assert.match(defSrc, /resolveDemoSuperAdminRoleId\(sb, tenantId\)/, 'seed must resolve the system role (fail-loudly)');
  assert.match(defSrc, /applyDemoOwnerAdminRole\(\{ sb, tenantId, memberId: ownerMemberId, roleId: superAdminRoleId/,
    'seed must assign it to the owner member row');
});

// ---------------------------------------------------------------------------
// Staff organisation linking (Task #3559): owner + admin personas belong to
// the tenant's primary organisation. Fill-null only, resolved never created.
// ---------------------------------------------------------------------------
const PRIMARY_ORG = { id: 'org-aesp', name: 'AESP', is_primary: true, tenant_id: TENANT_ID };
const EMPLOYER_ORG = { id: 'org-employer', name: 'Greenstone', is_primary: false, tenant_id: TENANT_ID };
const OTHER_TENANT_PRIMARY = { id: 'org-other', name: 'Other', is_primary: true, tenant_id: 'tenant-other' };

test('resolveDemoPrimaryOrganizationId: exactly one tenant-scoped primary org, never created', async () => {
  const { resolveDemoPrimaryOrganizationId } = await importEngine();
  const { sb, writes } = makeMockSb({ orgs: [EMPLOYER_ORG, PRIMARY_ORG, OTHER_TENANT_PRIMARY] });
  assert.equal(await resolveDemoPrimaryOrganizationId(sb, TENANT_ID), 'org-aesp');
  assert.equal(writes.length, 0, 'lookup only — no writes');
  const missing = makeMockSb({ orgs: [EMPLOYER_ORG, OTHER_TENANT_PRIMARY] });
  await assert.rejects(() => resolveDemoPrimaryOrganizationId(missing.sb, TENANT_ID), /Primary organisation not found/);
  assert.equal(missing.writes.length, 0);
  const dup = makeMockSb({ orgs: [PRIMARY_ORG, { ...PRIMARY_ORG, id: 'org-aesp-2' }] });
  await assert.rejects(() => resolveDemoPrimaryOrganizationId(dup.sb, TENANT_ID), /Multiple primary organisations/);
  assert.equal(dup.writes.length, 0);
});

test('applyDemoMemberOrganization: only an EMPTY link is filled — an existing organisation is kept', async () => {
  const { applyDemoMemberOrganization } = await importEngine();
  const cases = [
    [null, true],
    [EMPLOYER_ORG.id, false], // existing link has no provenance — never replaced
    [PRIMARY_ORG.id, true],   // already linked — reported linked, no write
  ];
  for (const [orgId, expectLinked] of cases) {
    const { sb, writes } = makeMockSb({
      members: [{ id: 'm-staff', email: 'staff@mock.example.com', organization_id: orgId }],
      orgs: [PRIMARY_ORG, EMPLOYER_ORG],
    });
    const linked = await applyDemoMemberOrganization({ sb, tenantId: TENANT_ID, memberId: 'm-staff', organizationId: PRIMARY_ORG.id, log: () => {} });
    assert.equal(linked, expectLinked, `organization_id=${orgId}`);
    const upd = writes.find((w) => w.table === 'member' && w.op === 'update');
    if (orgId === null) {
      assert.equal(upd.payload.organization_id, PRIMARY_ORG.id);
      assert.equal(upd.filters.tenant_id, TENANT_ID, 'update pinned to the demo tenant');
    } else {
      assert.ok(!upd, 'existing organisation link must never be replaced');
    }
  }
});

test('password reset links owner AND admin personas to the primary org; member personas untouched; missing org stays best-effort', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const staffDefinition = {
    ...mockDefinition,
    loginPersonas: () => [
      { name: 'Owner', email: 'owner@mock.example.com', role: 'Owner', kind: 'owner' },
      { name: 'Admin', email: 'admin@mock.example.com', role: 'Manager', kind: 'admin' },
      { name: 'Member', email: 'member@mock.example.com', role: 'Member', kind: 'member' },
    ],
  };
  const members = () => ([
    { id: 'm-owner', email: 'owner@mock.example.com', identity_id: 'ident-owner', organization_id: null },
    { id: 'm-admin', email: 'admin@mock.example.com', identity_id: null, organization_id: null },
    { id: 'm-member', email: 'member@mock.example.com', identity_id: null, organization_id: null },
  ]);
  const withOrg = makeMockSb({ tenant: mockTenant, members: members(), orgs: [PRIMARY_ORG] });
  await setDemoPortalPassword(staffDefinition, { sb: withOrg.sb, password: 'demo-pass-123', log: () => {} });
  const orgLinks = withOrg.writes.filter((w) => w.table === 'member' && w.op === 'update' && w.payload.organization_id);
  assert.deepEqual(orgLinks.map((w) => w.filters.id).sort(), ['m-admin', 'm-owner'],
    'owner and admin linked; member persona left without an employer');
  for (const w of orgLinks) assert.equal(w.payload.organization_id, PRIMARY_ORG.id);
  // Missing primary org → warning only, reset still succeeds.
  const noOrg = makeMockSb({ tenant: mockTenant, members: members(), orgs: [] });
  const result = await setDemoPortalPassword(staffDefinition, { sb: noOrg.sb, password: 'demo-pass-123', log: () => {} });
  assert.equal(result.updated, 3, 'reset must not fail because the primary org is missing');
  assert.ok(!noOrg.writes.some((w) => w.table === 'member' && w.op === 'update' && w.payload.organization_id));
});

test('seed wires staff personas and the owner to the primary organisation', () => {
  const defSrc = fs.readFileSync(new URL('../../demo-seeds/aesp/definition.mjs', import.meta.url), 'utf8');
  assert.match(defSrc, /resolveDemoPrimaryOrganizationId\(sb, tenantId\)/, 'seed must resolve the primary org (fail-loudly)');
  // Fail-fast: the resolver must run before the seed's FIRST write, so a
  // broken provisioning invariant never leaves a partial sample dataset.
  const seedAt = defSrc.indexOf('async seed(ctx)');
  const resolveAt = defSrc.indexOf('resolveDemoPrimaryOrganizationId(sb, tenantId)', seedAt);
  const firstWriteAt = defSrc.indexOf('await upsert(', seedAt);
  assert.ok(resolveAt > seedAt && resolveAt < firstWriteAt,
    'primary-org resolution must precede the first seed write');
  // Staff upserts must OMIT organization_id (undefined) and link fill-null
  // afterwards, so a reseed never clobbers a deliberately reassigned link.
  assert.match(defSrc, /plan\.lifecycle === 'staff' \? undefined : null/, 'staff upsert must omit organization_id');
  assert.match(defSrc, /if \(plan\.lifecycle === 'staff'\) \{\s*\n\s*await applyDemoMemberOrganization\(\{ sb, tenantId, memberId: member\.id, organizationId: primaryOrgId/,
    'staff must be linked via the fill-null helper after the upsert');
  assert.match(defSrc, /applyDemoMemberOrganization\(\{ sb, tenantId, memberId: ownerMemberId, organizationId: primaryOrgId/,
    'owner block must link her to the primary org (fill-null only)');
});

test('reseed semantics: admin deliberately moved to another organisation keeps it; unlinked admin gets the primary org', async () => {
  const { applyDemoMemberOrganization } = await importEngine();
  // Simulates the seed's post-upsert staff link on a reseed: the upsert
  // omitted organization_id, so whatever the row holds now is the input.
  const moved = makeMockSb({
    members: [{ id: 'm-admin', email: 'admin@mock.example.com', organization_id: EMPLOYER_ORG.id }],
    orgs: [PRIMARY_ORG, EMPLOYER_ORG],
  });
  assert.equal(await applyDemoMemberOrganization({ sb: moved.sb, tenantId: TENANT_ID, memberId: 'm-admin', organizationId: PRIMARY_ORG.id, log: () => {} }), false);
  assert.ok(!moved.writes.some((w) => w.table === 'member' && w.op === 'update'),
    'reseed must not move a deliberately reassigned admin back to the primary org');
  const fresh = makeMockSb({
    members: [{ id: 'm-admin', email: 'admin@mock.example.com', organization_id: null }],
    orgs: [PRIMARY_ORG],
  });
  assert.equal(await applyDemoMemberOrganization({ sb: fresh.sb, tenantId: TENANT_ID, memberId: 'm-admin', organizationId: PRIMARY_ORG.id, log: () => {} }), true);
  const upd = fresh.writes.find((w) => w.table === 'member' && w.op === 'update');
  assert.equal(upd.payload.organization_id, PRIMARY_ORG.id);
});

test('seed preflight: broken primary-org invariant aborts BEFORE any write to an existing tenant', async () => {
  const { seedDemoTenant } = await importEngine();
  const { resolveDemoPrimaryOrganizationId } = await importEngine();
  const preflightDefinition = {
    ...mockDefinition,
    version: 1,
    async preflight({ sb, tenantId }) { await resolveDemoPrimaryOrganizationId(sb, tenantId); },
    async seed() { throw new Error('seed must not run when preflight fails'); },
  };
  // Existing demo-marked tenant, but NO primary organisation.
  const { sb, writes } = makeMockSb({ tenant: mockTenant, orgs: [EMPLOYER_ORG] });
  await assert.rejects(
    () => seedDemoTenant(preflightDefinition, { sb, log: () => {} }),
    /Primary organisation not found/,
  );
  assert.equal(writes.length, 0, 'no engine write (demo marker/branding) may precede the preflight failure');
  // The aesp definition wires this exact preflight.
  const defSrc = fs.readFileSync(new URL('../../demo-seeds/aesp/definition.mjs', import.meta.url), 'utf8');
  assert.match(defSrc, /async preflight\(\{ sb, tenantId \}\) \{[\s\S]{0,200}resolveDemoPrimaryOrganizationId\(sb, tenantId\)/,
    'aesp definition must validate the primary org in preflight');
  // And the engine runs preflight before the tenant branding/marker update.
  const preflightAt = engineSrc.indexOf('definition.preflight === ');
  const brandingUpdateAt = engineSrc.indexOf("from('tenant').update(tenantPatch)");
  assert.ok(preflightAt > -1 && brandingUpdateAt > preflightAt, 'engine preflight must precede the tenant update');
});

test('race: organisation assigned between read and write is never overwritten (CAS loses gracefully)', async () => {
  const { applyDemoMemberOrganization } = await importEngine();
  const { sb, writes } = makeMockSb({
    // Read path reports organization_id null, but the stored row (which the
    // conditional UPDATE checks) was concurrently assigned an employer.
    members: [{ id: 'm-admin', email: 'admin@mock.example.com', organization_id: EMPLOYER_ORG.id }],
    orgs: [PRIMARY_ORG, EMPLOYER_ORG],
    readOrgAsNull: true,
  });
  const linked = await applyDemoMemberOrganization({ sb, tenantId: TENANT_ID, memberId: 'm-admin', organizationId: PRIMARY_ORG.id, log: () => {} });
  assert.equal(linked, false, 'concurrent assignment must win');
  assert.ok(writes.some((w) => w.table === 'member' && w.op === 'update' && w.filters['is:organization_id'] === null),
    'update must carry the organization_id IS NULL guard');
});

test('short passwords rejected; blank generates a strong one', async () => {
  const { setDemoPortalPassword } = await importEngine();
  const state = { tenant: mockTenant, members: [{ id: 'm-member', email: 'member@mock.example.com', identity_id: null }] };
  await assert.rejects(
    () => setDemoPortalPassword(mockDefinition, { sb: makeMockSb(state).sb, password: 'short', log: () => {} }),
    /at least 8 characters/,
  );
  const result = await setDemoPortalPassword(mockDefinition, { sb: makeMockSb(state).sb, log: () => {} });
  assert.ok(result.password.length >= 8);
});
