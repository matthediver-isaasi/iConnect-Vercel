/**
 * Task #1092 — One-shot, idempotent backfill of missing `tenant_membership`
 * link rows for members that already have `identity_id` + `tenant_id` but no
 * row in `tenant_membership` for that pair.
 *
 * Why: ~25% of members in tenant fd82da65-aab7-4a5c-85b8-b2febeb2003d have
 * no `tenant_membership` row. Login still works (the resolver falls back to
 * identity_id+tenant and then email+tenant), but the orange "No tenant
 * membership" warning badge shows in admin UIs and the auth resolver's
 * primary path is degraded for those accounts.
 *
 * SAFETY RULES (enforced per row, in this order — any failure = skip+log):
 *   1. Insert-only. No UPDATE / DELETE on any table.
 *   2. Skip soft-deleted members (isMemberSoftDeleted).
 *   3. Require both identity_id and tenant_id.
 *   4. Re-check tenant_membership existence per row inside the loop
 *      (interrupt-safe / re-run-safe).
 *   5. Auth-parity: resolveMemberForTenantLogin must return THIS member.id
 *      for (identityId, email, tenantId). Else skip — inserting could shift
 *      which member row the primary path picks.
 *   6. Skip if duplicateActiveMembers > 1 for (tenant, lower(email)).
 *   7. Canonical insert shape only:
 *        { identity_id, tenant_id, member_id, role:'member',
 *          membership_type:'member', status:'active', is_default }
 *   8. is_default=true only when the identity has zero existing
 *      tenant_membership rows across all tenants at insert time.
 *   9. Per-row try/catch; one failure must not abort the run.
 *   10. Throttle to ~50 inserts/sec.
 *
 * Usage:
 *   node scripts/backfill-tenant-membership.mjs                       # dry-run, all tenants
 *   node scripts/backfill-tenant-membership.mjs --tenant=<uuid>       # dry-run, single tenant
 *   node scripts/backfill-tenant-membership.mjs --tenant=<uuid> --apply
 *   node scripts/backfill-tenant-membership.mjs --apply --limit=10
 *   node scripts/backfill-tenant-membership.mjs --verbose
 */
import { createClient } from '@supabase/supabase-js';

// memberLoginResolver.js imports api/_lib/database.js which reads
// SUPABASE_URL / SUPABASE_SERVICE_KEY. Mirror DEST_* across BEFORE
// importing so the resolver's internal client (if used) hits the same DB.
if (!process.env.SUPABASE_URL && process.env.DEST_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
}
if (!process.env.SUPABASE_SERVICE_KEY && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const APPLY = !!args.apply;
const TENANT_FILTER = args.tenant || null;
const LIMIT = args.limit ? Number(args.limit) : null;
const VERBOSE = !!args.verbose;
const THROTTLE_MS = 20; // ~50/sec

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const { isMemberSoftDeleted, resolveMemberForTenantLogin } = await import(
  '../api/_lib/memberLoginResolver.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SKIP_REASONS = {
  soft_deleted: 0,
  no_identity: 0,
  no_tenant: 0,
  already_linked: 0,
  auth_resolves_different_member: 0,
  duplicate_active_members: 0,
  resolver_returned_null: 0,
};

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

async function fetchAllMembersPaged() {
  // Paginate to avoid the 1000-row default cap.
  const PAGE = 1000;
  let from = 0;
  const all = [];
  // Only need a handful of columns.
  while (true) {
    let q = supabase
      .from('member')
      .select('id, tenant_id, identity_id, email, organization_id')
      .not('identity_id', 'is', null)
      .not('tenant_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);
    const { data, error } = await q;
    if (error) throw new Error(`member fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function countCandidates() {
  // Count members with identity+tenant that have NO tenant_membership row.
  // Done by loading member ids+identity+tenant and probing tenant_membership
  // in batches. Returns { perTenant: Map<tenantId, count>, total }.
  const members = await fetchAllMembersPaged();
  const perTenant = new Map();
  let total = 0;
  // Probe membership existence per (identity_id, tenant_id) in chunks.
  // Keep chunk small to stay under URL length limits with the IN filters.
  const CHUNK = 100;
  const missingIds = new Set();
  for (let i = 0; i < members.length; i += CHUNK) {
    const chunk = members.slice(i, i + CHUNK);
    const identityIds = [...new Set(chunk.map((m) => m.identity_id))];
    const tenantIds = [...new Set(chunk.map((m) => m.tenant_id))];
    let probe = supabase
      .from('tenant_membership')
      .select('identity_id, tenant_id')
      .in('identity_id', identityIds);
    if (tenantIds.length === 1) probe = probe.eq('tenant_id', tenantIds[0]);
    else probe = probe.in('tenant_id', tenantIds);
    const { data: tms, error } = await probe;
    if (error) throw new Error(`tenant_membership probe failed: ${error.message}`);
    const present = new Set((tms || []).map((r) => `${r.identity_id}|${r.tenant_id}`));
    for (const m of chunk) {
      if (!present.has(`${m.identity_id}|${m.tenant_id}`)) {
        if (isMemberSoftDeleted(m)) continue;
        missingIds.add(m.id);
        total++;
        perTenant.set(m.tenant_id, (perTenant.get(m.tenant_id) || 0) + 1);
      }
    }
  }
  return { perTenant, total, missingMemberIds: missingIds };
}

async function identityHasAnyMembership(identityId) {
  const { data, error } = await supabase
    .from('tenant_membership')
    .select('id', { count: 'exact', head: true })
    .eq('identity_id', identityId)
    .limit(1);
  if (error) throw new Error(`identity probe failed: ${error.message}`);
  // head:true returns count via response; supabase-js v2 returns it on data
  // when select head used. Be defensive: also do a tiny select.
  if (Array.isArray(data) && data.length > 0) return true;
  const { data: rows } = await supabase
    .from('tenant_membership')
    .select('id')
    .eq('identity_id', identityId)
    .limit(1);
  return (rows || []).length > 0;
}

async function main() {
  log(`\n=== Backfill tenant_membership ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);
  log(`Tenant filter: ${TENANT_FILTER || '(all)'}  Limit: ${LIMIT || '(none)'}`);

  log('\n[pre-flight] counting candidates...');
  const pre = await countCandidates();
  log(`[pre-flight] candidates total: ${pre.total}`);
  for (const [t, c] of [...pre.perTenant.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  - tenant ${t}: ${c}`);
  }

  if (pre.total === 0) {
    log('\nNothing to do.');
    return;
  }

  // Load full member rows for candidates (we already have them via
  // fetchAllMembersPaged but countCandidates didn't keep them). Re-fetch
  // only the missing ids to keep memory bounded.
  const missingIds = [...pre.missingMemberIds];
  const candidates = [];
  const CHUNK = 100;
  for (let i = 0; i < missingIds.length; i += CHUNK) {
    const chunk = missingIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('member')
      .select('id, tenant_id, identity_id, email, organization_id')
      .in('id', chunk);
    if (error) throw new Error(`re-fetch failed: ${error.message}`);
    candidates.push(...(data || []));
  }

  const toProcess = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  log(`\nProcessing ${toProcess.length} candidate row(s)...`);

  let inserted = 0;
  let failed = 0;
  let skipped = 0;

  for (const m of toProcess) {
    try {
      // Rule 2
      if (isMemberSoftDeleted(m)) {
        SKIP_REASONS.soft_deleted++;
        skipped++;
        vlog(`  skip ${m.id} soft_deleted`);
        continue;
      }
      // Rule 3
      if (!m.identity_id) { SKIP_REASONS.no_identity++; skipped++; vlog(`  skip ${m.id} no_identity`); continue; }
      if (!m.tenant_id)   { SKIP_REASONS.no_tenant++;   skipped++; vlog(`  skip ${m.id} no_tenant`); continue; }

      // Rule 4 — re-check existence inside the loop
      const { data: existing, error: existErr } = await supabase
        .from('tenant_membership')
        .select('id')
        .eq('identity_id', m.identity_id)
        .eq('tenant_id', m.tenant_id)
        .limit(1);
      if (existErr) throw new Error(`existence check: ${existErr.message}`);
      if ((existing || []).length > 0) {
        SKIP_REASONS.already_linked++;
        skipped++;
        vlog(`  skip ${m.id} already_linked`);
        continue;
      }

      // Rule 5 + 6 — auth parity & duplicate guard via the same resolver
      // the live login flow uses.
      const resolution = await resolveMemberForTenantLogin({
        supabase,
        identityId: m.identity_id,
        email: m.email,
        tenantId: m.tenant_id,
      });

      if ((resolution.duplicateActiveMembers || []).length > 1) {
        SKIP_REASONS.duplicate_active_members++;
        skipped++;
        vlog(`  skip ${m.id} duplicate_active_members (${resolution.duplicateActiveMembers.length})`);
        continue;
      }
      if (!resolution.member) {
        SKIP_REASONS.resolver_returned_null++;
        skipped++;
        vlog(`  skip ${m.id} resolver_returned_null`);
        continue;
      }
      if (resolution.member.id !== m.id) {
        SKIP_REASONS.auth_resolves_different_member++;
        skipped++;
        vlog(`  skip ${m.id} auth_resolves_different_member (resolved=${resolution.member.id})`);
        continue;
      }

      // Rule 8 — is_default
      const hasAny = await identityHasAnyMembership(m.identity_id);
      const isDefault = !hasAny;

      const insertRow = {
        identity_id: m.identity_id,
        tenant_id: m.tenant_id,
        member_id: m.id,
        role: 'member',
        membership_type: 'member',
        status: 'active',
        is_default: isDefault,
      };

      if (!APPLY) {
        vlog(`  [dry] insert tm for member=${m.id} identity=${m.identity_id} tenant=${m.tenant_id} is_default=${isDefault}`);
        inserted++;
        continue;
      }

      const { error: insErr } = await supabase
        .from('tenant_membership')
        .insert(insertRow);
      if (insErr) {
        // 23505 = unique_violation — treat as already_linked (race-safe).
        if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
          SKIP_REASONS.already_linked++;
          skipped++;
          vlog(`  skip ${m.id} already_linked (race)`);
          continue;
        }
        throw new Error(`insert failed: ${insErr.message}`);
      }
      inserted++;
      vlog(`  inserted tm for member=${m.id} (is_default=${isDefault})`);
      await sleep(THROTTLE_MS);
    } catch (err) {
      failed++;
      console.error(`  [error] member=${m.id}: ${err.message}`);
    }
  }

  log('\n=== Summary ===');
  log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    inserted, skipped, failed,
    skipReasons: SKIP_REASONS,
  }, null, 2));

  // Post-flight verification
  log('\n[post-flight] re-counting candidates...');
  const post = await countCandidates();
  log(`[post-flight] candidates total: ${post.total}`);
  for (const [t, c] of [...post.perTenant.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  - tenant ${t}: ${c}`);
  }

  if (APPLY) {
    const expected = pre.total - inserted;
    if (post.total !== expected) {
      console.error(`\n[post-flight] MISMATCH: expected ${expected} remaining (pre=${pre.total} - inserted=${inserted}), got ${post.total}.`);
      process.exit(2);
    }
    log('\n[post-flight] OK — remaining count matches pre - inserted.');
  } else {
    log('\n(no rows were modified — re-run with --apply to perform inserts)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
