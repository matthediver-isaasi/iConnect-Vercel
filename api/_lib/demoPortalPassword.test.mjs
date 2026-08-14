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
      in(k, v) { filters[k] = v; return builder; },
      maybeSingle() { return resolve(true); },
      then(res, rej) { return resolve().then(res, rej); }, // awaited select/update chains
    };
    async function resolve(single = false) {
      if (op !== 'select') {
        writes.push({ table, op, payload, filters: { ...filters }, upsertOpts });
        const fail = state.failWrites?.[table];
        return fail ? { error: { message: fail } } : { error: null, data: null };
      }
      if (table === 'tenant') return { data: state.tenant, error: null };
      if (table === 'system_settings') return { data: null, error: null };
      if (table === 'member') {
        if (typeof filters.email === 'string') {
          const row = (state.members || []).find((m) => m.email === filters.email) || null;
          return { data: single ? row : (row ? [row] : []), error: null };
        }
        return { data: state.members, error: null };
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
