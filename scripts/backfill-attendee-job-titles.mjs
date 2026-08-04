// Backfill wrong attendee job titles (Task: historical rows created before the
// per-attendee job-title fix have the BOOKER's job title baked into
// attendee_job_title for attendees who are NOT the booker).
//
// Detection (per row, both booking + complex_event_booking):
//   - attendee_job_title is non-null/non-blank
//   - member_id is set and resolves to a booker member profile
//   - stored title equals the booker's profile job title (case-insensitive)
//   - attendee email AND name both do NOT match the booker (so the title was
//     misattributed; rows where the attendee IS the booker keep their title)
// Repair:
//   - if the attendee's email matches a member profile in the same tenant and
//     that profile has a job title, use it; otherwise clear to NULL.
//
// Usage:
//   node scripts/backfill-attendee-job-titles.mjs          # dry run (default)
//   node scripts/backfill-attendee-job-titles.mjs --apply  # apply updates
//
// Targets the production (DEST) database per workspace convention.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY environment variables');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const supabase = createClient(supabaseUrl, supabaseKey);

const norm = (v) => (v || '').toLowerCase().trim();

const PAGE = 1000;

async function fetchAllPaginated(table, columns, filterFn) {
  const rows = [];
  let from = 0;
  for (;;) {
    let q = supabase
      .from(table)
      .select(columns)
      .not('attendee_job_title', 'is', null)
      .not('member_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchMembersByIds(ids) {
  const map = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await supabase
      .from('member')
      .select('id, tenant_id, email, first_name, last_name, job_title')
      .in('id', chunk);
    if (error) throw new Error(`member fetch failed: ${error.message}`);
    for (const m of data || []) map.set(m.id, m);
  }
  return map;
}

async function fetchMembersByEmails(tenantEmailPairs) {
  // tenantEmailPairs: Set of `${tenant_id}|${email}` — fetch per-tenant batches
  const byTenant = new Map();
  for (const key of tenantEmailPairs) {
    const idx = key.indexOf('|');
    const tenant = key.slice(0, idx);
    const email = key.slice(idx + 1);
    if (!byTenant.has(tenant)) byTenant.set(tenant, new Set());
    byTenant.get(tenant).add(email);
  }
  const map = new Map(); // key `${tenant}|${email}` -> member
  for (const [tenant, emails] of byTenant) {
    const list = [...emails];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const { data, error } = await supabase
        .from('member')
        .select('id, tenant_id, email, job_title')
        .eq('tenant_id', tenant)
        .in('email', chunk);
      if (error) throw new Error(`member email fetch failed: ${error.message}`);
      for (const m of data || []) {
        const k = `${tenant}|${norm(m.email)}`;
        if (!map.has(k)) map.set(k, m);
      }
    }
  }
  return map;
}

function isMisattributed(row, booker) {
  const stored = norm(row.attendee_job_title);
  if (!stored) return false;
  const bookerTitle = norm(booker.job_title);
  if (!bookerTitle || stored !== bookerTitle) return false; // differs => per-attendee, keep

  const emailMatch = norm(row.attendee_email) && norm(row.attendee_email) === norm(booker.email);
  const attendeeName = `${norm(row.attendee_first_name)} ${norm(row.attendee_last_name)}`.trim();
  const bookerName = `${norm(booker.first_name)} ${norm(booker.last_name)}`.trim();
  const nameMatch = attendeeName && attendeeName === bookerName;

  return !(emailMatch || nameMatch); // attendee is NOT the booker
}

async function processTable(table) {
  console.log(`\n=== ${table} ===`);
  const rows = await fetchAllPaginated(
    table,
    'id, tenant_id, member_id, attendee_email, attendee_first_name, attendee_last_name, attendee_job_title'
  );
  console.log(`Examined ${rows.length} rows with a stored title + member_id`);

  const bookerIds = new Set(rows.map((r) => r.member_id).filter(Boolean));
  const bookers = await fetchMembersByIds(bookerIds);

  const flagged = rows.filter((r) => {
    const booker = bookers.get(r.member_id);
    return booker && isMisattributed(r, booker);
  });
  console.log(`Flagged ${flagged.length} misattributed rows`);

  // Look up attendee's own member profile by lowercased email within same tenant
  const emailKeys = new Set(
    flagged
      .filter((r) => norm(r.attendee_email) && r.tenant_id)
      .map((r) => `${r.tenant_id}|${norm(r.attendee_email)}`)
  );
  const attendeeMembers = await fetchMembersByEmails(emailKeys);

  let repaired = 0;
  let cleared = 0;
  const samples = { repaired: [], cleared: [] };

  for (const row of flagged) {
    const m = attendeeMembers.get(`${row.tenant_id}|${norm(row.attendee_email)}`);
    const newTitle = m && (m.job_title || '').trim() ? m.job_title.trim() : null;
    const kind = newTitle ? 'repaired' : 'cleared';
    if (newTitle) repaired++; else cleared++;
    if (samples[kind].length < 5) {
      samples[kind].push(
        `  id=${row.id} attendee=${row.attendee_first_name} ${row.attendee_last_name} <${row.attendee_email}> "${row.attendee_job_title}" -> ${newTitle === null ? 'NULL' : `"${newTitle}"`}`
      );
    }
    if (APPLY) {
      const { error } = await supabase
        .from(table)
        .update({ attendee_job_title: newTitle })
        .eq('id', row.id);
      if (error) throw new Error(`${table} update ${row.id} failed: ${error.message}`);
    }
  }

  console.log(`Repaired from attendee profile: ${repaired}`);
  if (samples.repaired.length) console.log(samples.repaired.join('\n'));
  console.log(`Cleared to NULL: ${cleared}`);
  if (samples.cleared.length) console.log(samples.cleared.join('\n'));

  return { table, examined: rows.length, flagged: flagged.length, repaired, cleared };
}

async function main() {
  console.log(APPLY ? 'APPLY mode — updates will be written' : 'DRY RUN — no changes will be made');
  const results = [];
  for (const table of ['booking', 'complex_event_booking']) {
    results.push(await processTable(table));
  }
  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.table}: examined=${r.examined} flagged=${r.flagged} repaired=${r.repaired} cleared=${r.cleared}`);
  }
  if (!APPLY) console.log('\nRe-run with --apply to write these changes.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
