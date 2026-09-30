#!/usr/bin/env node
/**
 * Strip dangling speaker ids from events and complex-event sessions (Task #1509).
 *
 * `event.speaker_ids` and `complex_event_session.speaker_ids` are plain UUID
 * arrays with no FK to the speaker table. When a speaker is deleted, its id is
 * left behind in those arrays. Count badges read the raw array length while
 * rendered lists silently drop ids that no longer resolve, so events can show
 * e.g. "1 speaker selected" with an empty speaker list.
 *
 * This script scans every event and complex-event session and removes any
 * speaker id that does not resolve to an active speaker record in the same
 * tenant. It is idempotent — running it again after a clean run is a no-op.
 *
 * A speaker id is considered dangling when no matching speaker row exists for
 * the tenant with is_active = true (mirrors the public speakers API, which only
 * ever returns active speakers — an inactive speaker is already invisible in the
 * rendered list, so its count badge should not include it either).
 *
 * Dry-run by default. Pass --apply to write changes.
 *
 * Usage:
 *   node scripts/prune-dangling-speaker-ids.mjs                 # all tenants, dry-run
 *   node scripts/prune-dangling-speaker-ids.mjs --apply         # all tenants, write
 *   node scripts/prune-dangling-speaker-ids.mjs --tenant=<uuid> # single tenant, dry-run
 *   node scripts/prune-dangling-speaker-ids.mjs --tenant=<uuid> --apply
 */

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});
const APPLY = !!args['apply'];
const TENANT_FILTER = args.tenant || null;

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

async function fetchAll(table, columns, applyFilters) {
  const rows = [];
  let offset = 0;
  while (true) {
    let query = supabase.from(table).select(columns).range(offset, offset + PAGE_SIZE - 1);
    query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw new Error(`fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += data.length;
  }
  return rows;
}

// Per-tenant cache of the set of active speaker ids.
const activeSpeakerCache = new Map();

async function getActiveSpeakerIds(tenantId) {
  if (activeSpeakerCache.has(tenantId)) return activeSpeakerCache.get(tenantId);
  const speakers = await fetchAll('speaker', 'id', (q) =>
    q.eq('tenant_id', tenantId).eq('is_active', true)
  );
  const set = new Set(speakers.map((s) => s.id));
  activeSpeakerCache.set(tenantId, set);
  return set;
}

async function pruneTable(table, tenantId) {
  const rows = await fetchAll(table, 'id, tenant_id, speaker_ids', (q) => {
    let query = q.not('speaker_ids', 'is', null);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    return query;
  });

  let rowsChanged = 0;
  let idsRemoved = 0;

  for (const row of rows) {
    const current = Array.isArray(row.speaker_ids) ? row.speaker_ids : [];
    if (current.length === 0) continue;
    if (!row.tenant_id) {
      console.warn(`  [${table}] ${row.id} has no tenant_id, skipping`);
      continue;
    }

    const activeIds = await getActiveSpeakerIds(row.tenant_id);
    const next = current.filter((sid) => activeIds.has(sid));

    if (next.length === current.length) continue;

    const removed = current.filter((sid) => !activeIds.has(sid));
    rowsChanged += 1;
    idsRemoved += removed.length;
    console.log(`  [${table}] ${row.id}: removing ${removed.length} dangling id(s) ${JSON.stringify(removed)} (${current.length} -> ${next.length})`);

    if (APPLY) {
      const { error } = await supabase.from(table).update({ speaker_ids: next }).eq('id', row.id);
      if (error) {
        console.error(`  [${table}] ${row.id}: update failed: ${error.message}`);
      }
    }
  }

  return { scanned: rows.length, rowsChanged, idsRemoved };
}

async function main() {
  console.log(`Prune dangling speaker ids — ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no writes)'}`);
  if (TENANT_FILTER) console.log(`Tenant filter: ${TENANT_FILTER}`);
  console.log('');

  const eventStats = await pruneTable('event', TENANT_FILTER);
  const sessionStats = await pruneTable('complex_event_session', TENANT_FILTER);

  console.log('');
  console.log('Summary:');
  console.log(`  event:                  scanned ${eventStats.scanned}, rows changed ${eventStats.rowsChanged}, ids removed ${eventStats.idsRemoved}`);
  console.log(`  complex_event_session:  scanned ${sessionStats.scanned}, rows changed ${sessionStats.rowsChanged}, ids removed ${sessionStats.idsRemoved}`);
  if (!APPLY) {
    console.log('');
    console.log('Dry run only — re-run with --apply to write these changes.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
