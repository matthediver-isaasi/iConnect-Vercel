// Demo tenant seeding engine 
//
// Generic, definition-driven framework for creating fully populated demo
// tenants. A demo tenant is described by a *definition module* (see
// demo-seeds/aesp/definition.mjs) and this engine provides the shared,
// safety-critical machinery:
//
//   - deterministic RNG (fixed string seed -> mulberry32)
//   - tenant provisioning via the existing provisionTenantService with
//     email/Mailgun side effects suppressed
//   - idempotent upserts keyed on stable natural keys (no duplicates on
//     re-run)
//   - a per-tenant manifest stored in system_settings (setting_key
//     'demo_seed_manifest') recording seed key, version, last-seeded time
//     and the ids of every seeded row per table, so reset/delete can remove
//     exactly what was seeded
//   - strict tenant scoping: every write and delete is constrained to the
//     demo tenant
//
// Definitions are data/config driven so future demo tenants (community club,
// org-centric trade body) reuse this engine with a new definition only.
//
// SAFETY: this engine performs direct table writes with the service-role
// client. It never calls the entity API, workflow triggers, email senders or
// payment providers — so seeding produces zero external side effects.

import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const MANIFEST_KEY = 'demo_seed_manifest';

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------
function xfnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return () => {
    h += h << 13; h ^= h >>> 7;
    h += h << 3; h ^= h >>> 17;
    return (h += h << 5) >>> 0;
  };
}

export function createRng(seedString) {
  let a = xfnv1a(seedString)();
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Weighted pick from [{ value, weight }]
    weighted: (items) => {
      const total = items.reduce((s, i) => s + i.weight, 0);
      let r = next() * total;
      for (const i of items) {
        r -= i.weight;
        if (r <= 0) return i.value;
      }
      return items[items.length - 1].value;
    },
    shuffle: (arr) => {
      const a2 = [...arr];
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// Bounded-concurrency map helper for parallel persistence. Determinism note:
// all RNG consumption must happen BEFORE parallel persistence (in a
// sequential planning phase); persistence order may vary but the data is
// already fixed.
export async function pmap(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Date helpers — all relative to the run date so demos never look stale
// ---------------------------------------------------------------------------
export function dateHelpers(now = new Date()) {
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
  const daysAhead = (n) => new Date(now.getTime() + n * 86400000);
  return {
    now,
    daysAgo,
    daysAhead,
    iso: (d) => d.toISOString(),
    isoDate: (d) => d.toISOString().slice(0, 10),
    year: now.getFullYear(),
  };
}

// ---------------------------------------------------------------------------
// Seed context — passed to definition.seed(ctx)
// ---------------------------------------------------------------------------
function createSeedContext({ sb, tenantId, tenant, definition, log }) {
  const manifest = {
    seedKey: definition.key,
    version: definition.version,
    tenantId,
    lastSeededAt: new Date().toISOString(),
    records: {}, // table -> [ids]
    counts: {},
  };

  const recordId = (table, id) => {
    if (!id) return;
    if (!manifest.records[table]) manifest.records[table] = [];
    if (!manifest.records[table].includes(id)) manifest.records[table].push(id);
  };

  /**
   * Idempotent upsert keyed on a natural-key `match` object. A tenant_id
   * filter/value is applied automatically unless `noTenantColumn` is set
   * (for tables without a tenant_id column, e.g. member_preference_value).
   * Returns the row (with id) and records its id in the manifest.
   */
  async function upsert(table, match, row, { noTenantColumn = false, select = 'id', insertOnly = false } = {}) {
    const fullMatch = noTenantColumn ? match : { tenant_id: tenantId, ...match };
    let q = sb.from(table).select(select).limit(2);
    for (const [k, v] of Object.entries(fullMatch)) q = q.eq(k, v);
    const { data: existing, error: selErr } = await q;
    if (selErr) throw new Error(`[seed] select ${table} failed: ${selErr.message}`);
    const fullRow = noTenantColumn ? row : { tenant_id: tenantId, ...row };
    if (existing && existing.length > 0) {
      const id = existing[0].id;
      if (insertOnly) {
        // Immutable rows (e.g. survey_version) — reuse the existing row as-is.
        recordId(table, id);
        return existing[0];
      }
      const { data: updated, error: updErr } = await sb.from(table).update(fullRow).eq('id', id).select(select).single();
      if (updErr) throw new Error(`[seed] update ${table} ${id} failed: ${updErr.message}`);
      recordId(table, id);
      return updated;
    }
    const { data: inserted, error: insErr } = await sb.from(table).insert({ ...fullMatch, ...fullRow }).select(select).single();
    if (insErr) throw new Error(`[seed] insert ${table} failed: ${insErr.message}`);
    recordId(table, inserted.id);
    return inserted;
  }

  return {
    sb,
    tenantId,
    tenant,
    log,
    manifest,
    upsert,
    recordId,
    setCount: (k, v) => { manifest.counts[k] = v; },
    hashPassword: (plain) => bcrypt.hash(plain, 10),
    randomPassword: () => crypto.randomBytes(9).toString('base64url'),
  };
}

async function saveManifest(sb, tenantId, manifest) {
  const { data: existing } = await sb
    .from('system_settings')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('setting_key', MANIFEST_KEY)
    .maybeSingle();
  const payload = {
    tenant_id: tenantId,
    setting_key: MANIFEST_KEY,
    setting_value: manifest,
    setting_type: 'json',
    description: `Demo seed manifest (${manifest.seedKey} ${manifest.version})`,
  };
  if (existing) {
    const { error } = await sb.from('system_settings').update(payload).eq('id', existing.id);
    if (error) throw new Error(`[seed] manifest update failed: ${error.message}`);
  } else {
    const { error } = await sb.from('system_settings').insert(payload);
    if (error) throw new Error(`[seed] manifest insert failed: ${error.message}`);
  }
}

export async function loadManifest(sb, tenantId) {
  const { data } = await sb
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', MANIFEST_KEY)
    .maybeSingle();
  const v = data?.setting_value;
  if (!v) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

/**
 * FK-violation- and timeout-resilient delete factory.
 *
 * Older seed iterations can leave child rows that the current manifest does
 * not track (its record lists are replaced wholesale each run). When a delete
 * is blocked by such a child, remove the blocking rows (they reference only
 * the given seeded, demo-ownership-verified parent ids) and retry —
 * recursively, since untracked children (e.g. members referencing an
 * organization) can have children of their own. Statement timeouts on heavy
 * FK graphs are handled by splitting the batch and retrying single rows.
 */
function makeFkClearingDelete(sb, tenantId, log) {
  const deleteWhere = async (tbl, col, values, { tenantScoped = false, depth = 0 } = {}) => {
    if (depth > 5) return { message: `FK clearing exceeded max depth at ${tbl}` };
    for (let attempt = 0; attempt < 10; attempt++) {
      let q = sb.from(tbl).delete().in(col, values);
      if (tenantScoped) q = q.eq('tenant_id', tenantId);
      const { error } = await q;
      if (!error) return null;
      if (/timeout/i.test(error.message)) {
        if (values.length > 1) {
          const mid = Math.ceil(values.length / 2);
          const e1 = await deleteWhere(tbl, col, values.slice(0, mid), { tenantScoped, depth });
          if (e1) return e1;
          const e2 = await deleteWhere(tbl, col, values.slice(mid), { tenantScoped, depth });
          if (e2) return e2;
          return null;
        }
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      const fk = /violates foreign key constraint "(.+?)" on table "(.+?)"/.exec(error.message);
      if (!fk) return error;
      const [, constraint, childTable] = fk;
      // Constraint names follow <child_table>_<column>_fkey.
      const childCol = constraint.startsWith(`${childTable}_`) && constraint.endsWith('_fkey')
        ? constraint.slice(childTable.length + 1, -'_fkey'.length)
        : null;
      if (!childCol) return error;
      log(`[cleanup] ${tbl}: clearing untracked child rows in ${childTable}.${childCol} and retrying`);
      // Fetch the blocking child-row ids so grandchildren can be cleared by
      // the child rows' own ids.
      const { data: childRows, error: selErr } = await sb.from(childTable).select('id').in(childCol, values).limit(2000);
      if (selErr) return selErr;
      const childIds = (childRows || []).map(r => r.id);
      if (!childIds.length) return error; // nothing to clear yet it still violates — give up
      const childErr = await deleteWhere(childTable, 'id', childIds, { depth: depth + 1 });
      if (childErr) return childErr;
    }
    return { message: 'too many FK retries' };
  };
  return deleteWhere;
}

async function findTenant(sb, slug) {
  const { data } = await sb.from('tenant').select('*').eq('slug', slug).maybeSingle();
  return data || null;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Seed (create-or-refresh) a demo tenant from its definition.
 * Idempotent: upserts by stable demo keys; re-running does not duplicate.
 */
/**
 * Guard: an existing tenant may only be mutated by this engine when it is
 * verifiably the engine's own demo tenant — i.e. it carries the demo marker
 * (settings.demo_seed.key) or a stored manifest whose seedKey matches this
 * definition. Otherwise refuse: a real customer tenant could share the slug.
 */
async function assertDemoOwnership(sb, tenant, definition, { allowAdopt = false } = {}) {
  const markerKey = tenant.settings?.demo_seed?.key;
  if (markerKey === definition.key) return;
  const manifest = await loadManifest(sb, tenant.id);
  if (manifest?.seedKey === definition.key) return;
  if (allowAdopt) return;
  throw new Error(
    `Tenant '${tenant.slug}' (${tenant.id}) exists but is NOT marked as the '${definition.key}' demo tenant ` +
    `(marker: ${markerKey || 'none'}). Refusing to modify it. If this tenant really should become the demo ` +
    `tenant, re-run with --adopt-existing-tenant.`
  );
}

export async function seedDemoTenant(definition, { sb, provisionTenant, log = console.log, size, adoptExisting = false } = {}) {
  const slug = definition.tenant.slug;
  let tenant = await findTenant(sb, slug);
  let adminSetup = null;

  if (!tenant) {
    log(`[seed] Provisioning demo tenant '${slug}' (no emails, no Mailgun)...`);
    const adminPassword = process.env.DEMO_SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const result = await provisionTenant({
      tenantName: definition.tenant.name,
      slug,
      adminEmail: definition.tenant.adminEmail,
      adminFirstName: definition.tenant.adminFirstName,
      adminLastName: definition.tenant.adminLastName,
      password: adminPassword,
      isPlatformProvision: true,
      generateSetupToken: false,
      skipEmailDomainProvisioning: true,
    });
    tenant = await findTenant(sb, slug);
    if (!tenant) throw new Error('Tenant provisioning appeared to succeed but tenant not found');
    adminSetup = {
      email: definition.tenant.adminEmail,
      password: process.env.DEMO_SEED_PASSWORD ? '(from DEMO_SEED_PASSWORD env)' : adminPassword,
      memberId: result.member?.id,
    };
  } else {
    await assertDemoOwnership(sb, tenant, definition, { allowAdopt: adoptExisting });
    log(`[seed] Tenant '${slug}' already exists (${tenant.id}) and is demo-marked — refreshing seed data.`);
  }

  // Mark the tenant as a demo tenant + apply identity/branding.
  const branding = definition.tenant.branding || {};
  const settings = {
    ...(tenant.settings || {}),
    demo_seed: { key: definition.key, version: definition.version, seeded_at: new Date().toISOString() },
    // Belt-and-braces: generic email-suppression hint for any consumer that
    // honours it. Direct-DB seeding never sends email regardless.
    demo_tenant: true,
  };
  const tenantPatch = {
    settings,
    description: definition.tenant.description || tenant.description,
    tagline: definition.tenant.tagline || tenant.tagline,
    ...branding, // primary_color, secondary_color, branding_config, etc.
  };
  const { error: tErr } = await sb.from('tenant').update(tenantPatch).eq('id', tenant.id);
  if (tErr) throw new Error(`[seed] tenant branding update failed: ${tErr.message}`);

  const ctx = createSeedContext({ sb, tenantId: tenant.id, tenant, definition, log });
  ctx.adminSetup = adminSetup;
  ctx.rng = createRng(definition.rngSeed || `${definition.key}:${definition.version}`);
  ctx.dates = dateHelpers();
  ctx.size = size || definition.defaultSize || 'small';

  await definition.seed(ctx);

  await saveManifest(sb, tenant.id, ctx.manifest);
  log(`[seed] Done. Manifest saved (${definition.version}).`);
  return { tenant, manifest: ctx.manifest, adminSetup };
}

/**
 * Remove exactly the rows recorded in the manifest (in reverse insertion
 * order), always additionally constrained to the demo tenant where the table
 * has a tenant_id column. The tenant itself and provisioning scaffolding
 * (roles, nav, admin owner) survive; use deleteDemoTenant for full removal.
 */
export async function resetDemoData(definition, { sb, log = console.log } = {}) {
  const tenant = await findTenant(sb, definition.tenant.slug);
  if (!tenant) { log('[reset] Tenant not found — nothing to reset.'); return { removed: 0 }; }
  await assertDemoOwnership(sb, tenant, definition);
  const manifest = await loadManifest(sb, tenant.id);
  if (!manifest?.records) { log('[reset] No manifest found — nothing to reset.'); return { removed: 0 }; }
  if (manifest.tenantId && manifest.tenantId !== tenant.id) {
    throw new Error('[reset] Manifest tenantId mismatch — refusing to delete.');
  }
  const noTenantColumn = new Set(definition.tablesWithoutTenantColumn || []);
  let removed = 0;
  const tables = Object.keys(manifest.records).reverse();
  // event_survey_assignment has a DB delete-guard: it refuses to die while
  // response_count > 0 or any form_submission still references it. Delete it
  // AFTER form_submission, and zero its response_count first.
  const esaIdx = tables.indexOf('event_survey_assignment');
  const fsIdx = tables.indexOf('form_submission');
  if (esaIdx !== -1 && fsIdx !== -1 && esaIdx < fsIdx) {
    tables.splice(esaIdx, 1);
    tables.splice(tables.indexOf('form_submission') + 1, 0, 'event_survey_assignment');
  }
  const skipTables = new Set(definition.resetSkipTables || []);
  for (const table of tables) {
    const ids = manifest.records[table];
    if (!ids?.length) continue;
    if (skipTables.has(table)) {
      // e.g. survey_version: append-only at the DB boundary (immutability
      // trigger blocks DELETE even for the service role). Rows have no FK
      // back to form, so they linger harmlessly as orphans.
      log(`[reset] ${table}: skipped ${ids.length} rows (append-only table)`);
      continue;
    }
    if (table === 'event_survey_assignment') {
      // Delete-guard trigger refuses while response_count > 0.
      const { error: zeroErr } = await sb.from('event_survey_assignment')
        .update({ response_count: 0 }).in('id', ids).eq('tenant_id', tenant.id);
      if (zeroErr) throw new Error(`[reset] zero response_count failed: ${zeroErr.message}`);
    }
    const deleteWhere = makeFkClearingDelete(sb, tenant.id, log);
    const deleteBatch = (batch) => deleteWhere(table, 'id', batch, { tenantScoped: !noTenantColumn.has(table) });
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      let error = await deleteBatch(batch);
      if (error && /timeout/i.test(error.message)) {
        // Heavy FK graphs (e.g. member) can exceed the statement timeout in
        // bulk; fall back to row-at-a-time deletes, retrying transient
        // timeouts (each retry has less cascade work left to do).
        for (const id of batch) {
          for (let attempt = 0; attempt < 4; attempt++) {
            error = await deleteBatch([id]);
            if (!error || !/timeout/i.test(error.message)) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
          if (error) break;
        }
      }
      if (error) throw new Error(`[reset] delete from ${table} failed: ${error.message}`);
    }
    removed += ids.length;
    log(`[reset] ${table}: removed up to ${ids.length} rows`);
  }
  // Clear the manifest record list but keep the marker row for status.
  await saveManifest(sb, tenant.id, { ...manifest, records: {}, counts: {}, lastResetAt: new Date().toISOString() });
  log(`[reset] Done. ${removed} seeded rows removed.`);
  return { removed };
}

/**
 * Delete the entire demo tenant: all seeded data, provisioning scaffolding
 * and the tenant row itself. Every delete is scoped by tenant_id; identity
 * rows are removed only when they have no memberships in other tenants.
 */
export async function deleteDemoTenant(definition, { sb, log = console.log } = {}) {
  const tenant = await findTenant(sb, definition.tenant.slug);
  if (!tenant) { log('[delete] Tenant not found — nothing to delete.'); return { deleted: false }; }
  await assertDemoOwnership(sb, tenant, definition);
  const tenantId = tenant.id;

  // First remove manifest-tracked rows (covers tables without tenant_id).
  await resetDemoData(definition, { sb, log });

  // Identities linked only to this tenant get cleaned up after memberships.
  const { data: memberships } = await sb.from('tenant_membership').select('identity_id').eq('tenant_id', tenantId);
  const identityIds = [...new Set((memberships || []).map(m => m.identity_id).filter(Boolean))];

  const tenantScopedTables = definition.deleteTables || [
    'member_communication_preference', 'communication_category',
    'member_membership_invoicing', 'member_membership_history',
    'membership_tier_band', 'membership_tier_config',
    'member_credentials', 'tenant_user_member_link',
    'tenant_membership_credentials', 'tenant_membership',
    'member', 'preference_field',
    'navigation_item', 'portal_navigation_item', 'portal_menu',
    'role_member_field_permission', // handled below via role ids
    'system_settings', 'organization',
    'tenant_user_credentials', // via tenant_user ids
    'tenant_user', 'role',
  ];

  // Role/tenant_user-child tables need id-based deletes.
  const { data: roles } = await sb.from('role').select('id').eq('tenant_id', tenantId);
  const roleIds = (roles || []).map(r => r.id);
  const { data: tusers } = await sb.from('tenant_user').select('id').eq('tenant_id', tenantId);
  const tuserIds = (tusers || []).map(u => u.id);

  const deleteWhere = makeFkClearingDelete(sb, tenantId, log);

  // The role table has a protection trigger that blocks deleting system
  // roles (e.g. Super Admin). The platform tenant-delete flow disables it
  // around role deletion via a dedicated RPC pair; do the same here.
  let roleTriggerDisabled = false;
  try {
    const { error: disableErr } = await sb.rpc('disable_role_protection_trigger');
    if (!disableErr) roleTriggerDisabled = true;
    else log(`[delete] warning: could not disable role protection trigger: ${disableErr.message}`);
  } catch (e) {
    log(`[delete] warning: role trigger disable exception: ${e.message}`);
  }

  try {
  for (const table of tenantScopedTables) {
    let error = null;
    if (table === 'role_member_field_permission') {
      if (roleIds.length) error = await deleteWhere(table, 'role_id', roleIds);
      if (roleIds.length) await deleteWhere('role_organization_field_permission', 'role_id', roleIds);
    } else if (table === 'tenant_user_credentials') {
      if (tuserIds.length) error = await deleteWhere(table, 'tenant_user_id', tuserIds);
    } else {
      error = await deleteWhere(table, 'tenant_id', [tenantId]);
    }
    if (error && !/does not exist|column/.test(error.message)) {
      log(`[delete] warning: ${table}: ${error.message}`);
    }
  }

  // member_preference_value has no tenant column — manifest reset removed
  // seeded rows already; remove any residual rows for this tenant's members.
  // (members are already deleted above, so nothing left to key from — the
  // manifest path is authoritative for this table.)

  const tenErr = await deleteWhere('tenant', 'id', [tenantId]);
  if (tenErr) throw new Error(`[delete] tenant delete failed: ${tenErr.message}`);
  } finally {
    if (roleTriggerDisabled) {
      try {
        const { error: enableErr } = await sb.rpc('enable_role_protection_trigger');
        if (enableErr) log(`[delete] warning: could not re-enable role protection trigger: ${enableErr.message}`);
      } catch (e) {
        log(`[delete] warning: role trigger re-enable exception: ${e.message}`);
      }
    }
  }

  // Remove identities that no longer belong to any tenant.
  for (const idn of identityIds) {
    const { data: still } = await sb.from('tenant_membership').select('id').eq('identity_id', idn).limit(1);
    if (!still?.length) {
      await sb.from('tenant_identity').delete().eq('id', idn);
    }
  }
  log(`[delete] Demo tenant '${definition.tenant.slug}' fully removed.`);
  return { deleted: true };
}

/**
 * Set (or reset) the shared portal password for a demo tenant's login
 * personas. Scoped strictly to the definition's own tenant (demo-ownership
 * asserted) and to seeded persona members (is_sample rows matched by the
 * definition's loginPersonas emails). Updates the credential stores the
 * login flow consults (precedence: tenant_membership_credentials >
 * tenant_identity > member_credentials):
 *   - member_credentials is upserted for every persona (the store the
 *     seeder writes);
 *   - when a persona has a tenant_identity, the (identity, tenant)
 *     tenant_membership_credentials row is UPSERTED — not just updated —
 *     so a stale shared identity hash can never shadow the new password.
 * tenant_identity.password_hash is deliberately never written: identities
 * are cross-tenant, and the per-tenant credential row wins the precedence
 * anyway.
 *
 * Personas WITHOUT a seeded member row (e.g. an owner created only as a
 * tenant_identity at provision time) are repaired, not skipped: their
 * identity is resolved by email, the (identity, tenant) credential row is
 * upserted, and the sample member row + tenant_membership linkage the login
 * resolver needs are created/repaired — all scoped to the demo tenant.
 *
 * Returns per-persona outcomes ('updated' | 'repaired' | 'skipped' |
 * 'failed') plus the plaintext password exactly once to the caller. A
 * persona-level write failure is recorded (not thrown) so one broken
 * persona cannot hide the others' success; if NO persona succeeds the
 * operation throws.
 */
export async function setDemoPortalPassword(definition, { sb, password, log = console.log } = {}) {
  if (!sb) throw new Error('supabase client required');
  const personas = typeof definition.loginPersonas === 'function' ? definition.loginPersonas() : [];
  if (!personas.length) throw new Error(`Definition '${definition.key}' declares no login personas`);

  const plain = password != null && String(password).length > 0
    ? String(password)
    : crypto.randomBytes(9).toString('base64url');
  if (plain.length < 8) throw new Error('Password must be at least 8 characters');

  const tenant = await findTenant(sb, definition.tenant.slug);
  if (!tenant) throw new Error(`Demo tenant '${definition.tenant.slug}' is not installed`);
  await assertDemoOwnership(sb, tenant, definition);
  const tenantId = tenant.id;

  const emails = personas.map((p) => p.email.toLowerCase());
  const passwordHash = await bcrypt.hash(plain, 10);

  // Persona member rows — tenant-scoped AND demo-marked, so a colliding
  // email in another tenant (or a non-seeded member) can never be touched.
  const { data: members, error: memErr } = await sb
    .from('member')
    .select('id, email, identity_id')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .in('email', emails);
  if (memErr) throw new Error(`persona member lookup failed: ${memErr.message}`);
  const memberByEmail = new Map((members || []).map((m) => [m.email.toLowerCase(), m]));

  // Shared helpers (also used by the seed phase to create the owner at seed
  // time, so she never needs this repair path after a fresh seed).
  const writeCredentials = (email, memberId, identityId) =>
    writeDemoPersonaCredentials({ sb, tenantId, email, memberId, identityId, passwordHash });
  const resolveIdentityId = (email, memberIdentityId = null) =>
    memberIdentityId ? Promise.resolve(memberIdentityId) : resolveDemoIdentityId(sb, email);
  const repairIdentityPersona = (persona, identityId) =>
    repairDemoIdentityPersona({ sb, tenantId, persona, identityId, passwordHash });

  const outcomes = [];
  let updated = 0;
  let repaired = 0;
  for (const persona of personas) {
    const email = persona.email.toLowerCase();
    const base = { name: persona.name, email: persona.email, role: persona.role, kind: persona.kind };
    try {
      const m = memberByEmail.get(email);
      if (m) {
        const identityId = await resolveIdentityId(email, m.identity_id);
        await writeCredentials(m.email, m.id, identityId);
        updated++;
        outcomes.push({ ...base, outcome: 'updated' });
        continue;
      }
      // No seeded member row — identity-backed repair path.
      const identityId = await resolveIdentityId(email);
      if (!identityId) {
        outcomes.push({
          ...base, outcome: 'skipped',
          reason: 'no seeded member row and no tenant_identity — reseed to restore this persona',
        });
        continue;
      }
      await repairIdentityPersona(persona, identityId);
      repaired++;
      outcomes.push({ ...base, outcome: 'repaired' });
    } catch (err) {
      outcomes.push({ ...base, outcome: 'failed', reason: err.message });
    }
  }

  // If nothing succeeded the reported password would be a lie — fail loudly.
  if (updated + repaired === 0) {
    const firstFailure = outcomes.find((o) => o.outcome === 'failed');
    if (firstFailure) throw new Error(firstFailure.reason);
    throw new Error('No seeded persona members found — run a seed first');
  }

  log(`[demo-password] Portal password set on '${definition.tenant.slug}': ${updated} updated, ${repaired} repaired, ${outcomes.length - updated - repaired} not updated`);
  return {
    password: plain,
    updated: updated + repaired,
    repaired,
    personas: outcomes.map((o) => ({ ...o, found: o.outcome === 'updated' || o.outcome === 'repaired' })),
  };
}

// ---------------------------------------------------------------------------
// Shared persona login helpers — used by setDemoPortalPassword above AND by
// seed definitions (e.g. the AESP owner block) so a fresh seed creates the
// owner's member row, tenant_membership linkage and credential rows itself.
// ---------------------------------------------------------------------------

/** Resolve a tenant_identity id by email (read-only; may return null). */
export async function resolveDemoIdentityId(sb, email) {
  const { data: ident, error: identErr } = await sb.from('tenant_identity').select('id').eq('email', email).maybeSingle();
  if (identErr) throw new Error(`identity lookup failed for ${email}: ${identErr.message}`);
  return ident?.id || null;
}

/**
 * Writes the credential stores a resolvable persona needs. Errors throw
 * with a descriptive message; callers record them per persona.
 */
export async function writeDemoPersonaCredentials({ sb, tenantId, email, memberId, identityId, passwordHash }) {
  // member_credentials (the store the seeder writes) — upsert by
  // (tenant, email) like the seeder, clearing lockout state.
  const credRow = {
    tenant_id: tenantId, member_id: memberId, email,
    password_hash: passwordHash, is_temporary: false, is_temp_password: false,
    failed_login_attempts: 0, locked_until: null,
    reset_token: null, reset_token_expires: null,
  };
  const { data: existingCred, error: credSelErr } = await sb
    .from('member_credentials').select('id')
    .eq('tenant_id', tenantId).eq('email', email).maybeSingle();
  if (credSelErr) throw new Error(`member_credentials lookup failed for ${email}: ${credSelErr.message}`);
  if (existingCred) {
    const { error } = await sb.from('member_credentials').update(credRow).eq('id', existingCred.id);
    if (error) throw new Error(`member_credentials update failed for ${email}: ${error.message}`);
  } else {
    const { error } = await sb.from('member_credentials').insert(credRow);
    if (error) throw new Error(`member_credentials insert failed for ${email}: ${error.message}`);
  }

  // tenant_membership_credentials — the login flow checks this (identity,
  // tenant) row FIRST, and falls back to the cross-tenant tenant_identity
  // hash before ever reaching member_credentials. So when the persona has
  // an identity, the per-tenant row must EXIST with the new hash — upsert,
  // never update-only — or a stale shared identity hash would shadow the
  // new password. The shared tenant_identity hash itself is never written
  // (the identity may belong to other tenants).
  if (identityId) {
    // Atomic conflict-targeted upsert on the (identity_id, tenant_id)
    // unique key. A failure here MUST fail this persona: this store
    // governs the persona's login, so silently skipping it would report
    // a password that does not actually work.
    const { error: tmcErr } = await sb
      .from('tenant_membership_credentials')
      .upsert({
        identity_id: identityId, tenant_id: tenantId,
        password_hash: passwordHash, failed_attempts: 0, locked_until: null,
        reset_token: null, reset_token_expires: null,
      }, { onConflict: 'identity_id,tenant_id' });
    if (tmcErr) throw new Error(`tenant credentials upsert failed for ${email}: ${tmcErr.message}`);
  }
}

/**
 * Identity-backed create/repair for a persona (e.g. the tenant owner, who
 * may exist only as a tenant_identity from provisioning). Creates/repairs
 * the demo-tenant member row and the tenant_membership linkage the login
 * resolver walks, then writes the credential stores. Everything is scoped
 * to the given (demo-asserted) tenant; tenant_identity is only read, never
 * written. `identityId` may be null (seed-time fallback): the member and
 * member_credentials rows are still created, the identity-keyed rows are
 * skipped. Returns the member id.
 */
export async function repairDemoIdentityPersona({ sb, tenantId, persona, identityId, passwordHash, memberPatch = {} }) {
  const email = persona.email.toLowerCase();
  // Member row: repair an existing row in THIS tenant (whatever its
  // sample flag — the tenant itself is demo-asserted) or create one.
  const { data: existing, error: exErr } = await sb
    .from('member').select('id, identity_id')
    .eq('tenant_id', tenantId).eq('email', email).maybeSingle();
  if (exErr) throw new Error(`member lookup failed for ${email}: ${exErr.message}`);
  let memberId = existing?.id || null;
  const nameParts = String(persona.name || '').trim().split(/\s+/);
  const lastName = nameParts.length > 1 ? nameParts.pop() : '';
  const firstName = nameParts.join(' ') || persona.name || email;
  // Never null out an existing identity linkage when no identity resolved.
  const identityPatch = identityId ? { identity_id: identityId } : {};
  if (memberId) {
    const { error } = await sb.from('member').update({
      ...identityPatch, is_sample: true, login_enabled: true, status: 'active',
      ...memberPatch,
    }).eq('id', memberId).eq('tenant_id', tenantId);
    if (error) throw new Error(`member repair failed for ${email}: ${error.message}`);
  } else {
    const { data: created, error } = await sb.from('member').insert({
      tenant_id: tenantId, email, first_name: firstName, last_name: lastName,
      job_title: persona.role || null, ...identityPatch,
      is_sample: true, login_enabled: true, status: 'active',
      ...memberPatch,
    }).select('id').single();
    if (error) throw new Error(`member create failed for ${email}: ${error.message}`);
    memberId = created.id;
  }

  // tenant_membership linkage — the login resolver's first lookup is
  // (identity_id, tenant_id) → member_id, so make sure a row exists and
  // points at the member.
  if (identityId) {
    const { data: tmRows, error: tmSelErr } = await sb
      .from('tenant_membership').select('id, member_id')
      .eq('identity_id', identityId).eq('tenant_id', tenantId);
    if (tmSelErr) throw new Error(`tenant_membership lookup failed for ${email}: ${tmSelErr.message}`);
    const tm = (tmRows || [])[0];
    if (tm) {
      if (tm.member_id !== memberId) {
        const { error } = await sb.from('tenant_membership')
          .update({ member_id: memberId, status: 'active' })
          .eq('id', tm.id).eq('tenant_id', tenantId);
        if (error) throw new Error(`tenant_membership repair failed for ${email}: ${error.message}`);
      }
    } else {
      const role = persona.kind === 'owner' ? 'owner' : 'member';
      const { error } = await sb.from('tenant_membership').insert({
        identity_id: identityId, tenant_id: tenantId, member_id: memberId,
        role, membership_type: role, status: 'active',
      });
      if (error) throw new Error(`tenant_membership create failed for ${email}: ${error.message}`);
    }
  }

  await writeDemoPersonaCredentials({ sb, tenantId, email, memberId, identityId, passwordHash });
  return memberId;
}

export async function demoTenantStatus(definition, { sb } = {}) {
  const tenant = await findTenant(sb, definition.tenant.slug);
  if (!tenant) return { installed: false };
  const manifest = await loadManifest(sb, tenant.id);
  return {
    installed: true,
    tenantId: tenant.id,
    slug: tenant.slug,
    seedVersion: manifest?.version || tenant.settings?.demo_seed?.version || null,
    lastSeededAt: manifest?.lastSeededAt || null,
    counts: manifest?.counts || {},
  };
}
