#!/usr/bin/env node
/**
 * Normalize existing member emails to lowercase so they match the app-wide
 * convention and resolve in the login flow (which looks members up with
 * lower(email)). Members imported before the import fix stored the raw
 * mixed-case email and therefore showed a misleading "No Member Record" badge
 * and could not log in via the normal path.
 *
 * Safety:
 *   - Dry-run by DEFAULT. Pass --apply to actually write changes.
 *   - Scoped to a single tenant (defaults to the BNMS tenant). Pass
 *     --tenant=<uuid> to target a different tenant, or --all-tenants to sweep
 *     every tenant.
 *   - Idempotent: rows that are already lowercase are skipped, so it is safe to
 *     run repeatedly.
 *   - Collision-safe: if lowercasing an email would clash with an existing
 *     (already-lowercase) member in the same tenant, the row is REPORTED as a
 *     conflict and left untouched — never silently merged.
 *
 * Reads/writes the destination (prod) Supabase via @supabase/supabase-js with
 * the service-role key (REST endpoint is IPv4-reachable from this workspace;
 * the direct Postgres host is not — see replit.md "Database connection").
 *
 * Usage:
 *   node scripts/normalize-member-emails.mjs                       # dry-run, BNMS tenant
 *   node scripts/normalize-member-emails.mjs --apply               # apply, BNMS tenant
 *   node scripts/normalize-member-emails.mjs --tenant=<uuid>       # dry-run, given tenant
 *   node scripts/normalize-member-emails.mjs --tenant=<uuid> --apply
 *   node scripts/normalize-member-emails.mjs --all-tenants --apply # every tenant
 */

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});

const APPLY = !!args['apply'];
const ALL_TENANTS = !!args['all-tenants'];
const DEFAULT_BNMS_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const TENANT_ID = ALL_TENANTS ? null : (args.tenant || DEFAULT_BNMS_TENANT);

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const PAGE_SIZE = 1000;

async function fetchAllMembers() {
  const all = [];
  let from = 0;
  while (true) {
    let query = supabase
      .from('member')
      .select('id, email, tenant_id')
      .not('email', 'is', null)
      .neq('email', '')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (TENANT_ID) query = query.eq('tenant_id', TENANT_ID);

    const { data, error } = await query;
    if (error) {
      console.error('Failed to fetch members:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function run() {
  console.log(
    `[normalize-emails] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} scope=${ALL_TENANTS ? 'ALL TENANTS' : TENANT_ID}`
  );

  const members = await fetchAllMembers();
  console.log(`[normalize-emails] Loaded ${members.length} members with emails.`);

  // Build per-tenant set of emails that are already lowercase, so we can detect
  // collisions before changing anything.
  const lowerEmailOwners = new Map(); // key: `${tenant_id}::${lowerEmail}` -> [memberId,...]
  for (const m of members) {
    const lower = (m.email || '').trim().toLowerCase();
    const key = `${m.tenant_id}::${lower}`;
    if (!lowerEmailOwners.has(key)) lowerEmailOwners.set(key, []);
    lowerEmailOwners.get(key).push(m.id);
  }

  const toChange = members.filter((m) => m.email !== m.email.trim().toLowerCase());
  console.log(`[normalize-emails] ${toChange.length} members have mixed-case (or untrimmed) emails.`);

  let updated = 0;
  let conflicts = 0;
  let failed = 0;

  for (const m of toChange) {
    const lower = m.email.trim().toLowerCase();
    const key = `${m.tenant_id}::${lower}`;
    const owners = (lowerEmailOwners.get(key) || []).filter((id) => id !== m.id);

    if (owners.length > 0) {
      conflicts++;
      console.warn(
        `[normalize-emails] CONFLICT: member ${m.id} "${m.email}" -> "${lower}" already used by ${owners.join(', ')} (tenant ${m.tenant_id}); skipping.`
      );
      continue;
    }

    if (!APPLY) {
      console.log(`[normalize-emails] would update ${m.id}: "${m.email}" -> "${lower}"`);
      updated++;
      continue;
    }

    const { error } = await supabase.from('member').update({ email: lower }).eq('id', m.id);
    if (error) {
      failed++;
      console.error(`[normalize-emails] FAILED ${m.id} "${m.email}" -> "${lower}": ${error.message}`);
    } else {
      updated++;
      // Keep the in-memory owner map consistent so a later row in the same run
      // correctly detects a now-occupied lowercase email.
      lowerEmailOwners.get(key).push(m.id);
    }
  }

  console.log(
    `[normalize-emails] Done. ${APPLY ? 'updated' : 'would update'}=${updated}, conflicts=${conflicts}, failed=${failed}`
  );
  if (!APPLY) {
    console.log('[normalize-emails] DRY-RUN only — re-run with --apply to write changes.');
  }
}

run().catch((err) => {
  console.error('[normalize-emails] Unexpected error:', err);
  process.exit(1);
});
