#!/usr/bin/env node
/**
 * Import GSF individuals from XLSX spreadsheet into the Global Schools Forum
 * tenant as members, and set each person's communication-category subscriptions.
 *
 * Spreadsheet: attached_assets/Individuals_to_import_into_iConnect_01.07.26_1782920091964.xlsx
 * Columns: Iconnect unique id, first_name, last_name, email, role_name, job_title,
 *          Community Newsletter (Snapshot), Event Updates
 *
 * - Members matched by lowercased email (app-wide convention).
 * - Existing members: update first_name, last_name, job_title, role_id (only when sheet provides a value).
 * - New members: insert with GSF tenant_id, lowercased email, mapped role_id.
 * - Upserts two member_communication_preference rows per member (one per category).
 * - Tenant-pinned: refuses to run for any other tenant id.
 * - Idempotent: re-running with --apply after a successful run produces zero (or near-zero) writes.
 * - Dry-run by default; require --apply to write.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/import-gsf-individuals.mjs \
 *     [--apply] [--verbose] [--file=<path>] [--limit=N]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import xlsx from 'xlsx';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';

// Communication categories — verified at startup; fail if they drift.
const CATEGORIES = [
  {
    column: 'Community Newsletter (Snapshot)',
    id: 'f4522519-a535-46b4-8685-d6e2ff22b6f5',
    name: 'Community Newsletter (Snapshot)',
  },
  {
    column: 'Event Updates',
    id: '478810ca-9d68-435b-8eba-32728cb2dee7',
    name: 'Event Updates',
  },
];

const DEFAULT_FILE =
  'attached_assets/Individuals_to_import_into_iConnect_01.07.26_1782920091964.xlsx';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const fileArg = args.find(a => a.startsWith('--file='));
const limitArg = args.find(a => a.startsWith('--limit='));
const XLSX_PATH = fileArg ? fileArg.slice('--file='.length) : DEFAULT_FILE;
const LIMIT = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) || null : null;

// ---------- credentials ----------
const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[import-gsf-individuals] Missing Supabase credentials (DEST_SUPABASE_URL / DEST_SUPABASE_KEY).');
  process.exit(1);
}

const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;
if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[import-gsf-individuals] Refusing to run for tenant ${TENANT_ID}. ` +
    `This script is hard-pinned to ${ALLOWED_TENANT_ID}.`,
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------- helpers ----------
function trimStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function emptyToNull(v) {
  const s = trimStr(v);
  return s === '' ? null : s;
}

/** 'Yes' (case-insensitive) -> true; 'No' or blank -> false */
function parseYesNo(v) {
  return trimStr(v).toLowerCase() === 'yes';
}

// ---------- parse XLSX ----------
function loadXlsx(filePath) {
  const abs = resolvePath(filePath);
  const wb = xlsx.readFile(abs);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // header_row: 1-indexed; raw: true keeps numbers as-is
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

  const EXPECTED_COLS = [
    'Iconnect unique id',
    'first_name',
    'last_name',
    'email',
    'role_name',
    'job_title',
    'Community Newsletter (Snapshot)',
    'Event Updates',
  ];

  if (rows.length === 0) {
    return { byEmail: new Map(), rowCount: 0, blank: 0, skipped: [], dupes: 0 };
  }

  // Validate columns present
  const actualCols = Object.keys(rows[0]);
  const missing = EXPECTED_COLS.filter(c => !actualCols.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `Spreadsheet is missing required column(s): ${missing.join(', ')}. ` +
      `Found: ${actualCols.join(', ')}`,
    );
  }

  const byEmail = new Map(); // emailLower -> record
  let rowCount = 0;
  let blank = 0;
  let dupes = 0;
  const skipped = [];

  for (const row of rows) {
    const emailRaw = trimStr(row['email']);
    if (!emailRaw) {
      blank++;
      continue;
    }
    rowCount++;

    const emailLower = emailRaw.toLowerCase();
    if (!EMAIL_RE.test(emailLower)) {
      skipped.push({ reason: 'bad_email', value: emailRaw });
      continue;
    }

    const record = {
      first_name: emptyToNull(row['first_name']),
      last_name: emptyToNull(row['last_name']),
      role_name: emptyToNull(row['role_name']),
      job_title: emptyToNull(row['job_title']),
      newsletter: parseYesNo(row['Community Newsletter (Snapshot)']),
      events: parseYesNo(row['Event Updates']),
    };

    if (byEmail.has(emailLower)) dupes++; // last-write-wins
    byEmail.set(emailLower, record);
  }

  return { byEmail, rowCount, blank, skipped, dupes };
}

// ---------- DB helpers ----------
async function fetchAllPaged(table, select, filters = {}) {
  const out = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`Paged fetch from ${table} failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

// ---------- startup checks ----------
async function verifyCategories() {
  const ids = CATEGORIES.map(c => c.id);
  const { data, error } = await supabase
    .from('communication_category')
    .select('id, name, tenant_id, is_active')
    .in('id', ids);
  if (error) throw new Error(`communication_category lookup failed: ${error.message}`);
  const byId = new Map((data || []).map(c => [c.id, c]));
  for (const c of CATEGORIES) {
    const found = byId.get(c.id);
    if (!found) throw new Error(`Category ${c.id} (${c.name}) not found in DB — verify category IDs`);
    if (found.tenant_id !== TENANT_ID) {
      throw new Error(`Category ${c.id} belongs to tenant ${found.tenant_id}, expected ${TENANT_ID}`);
    }
    if (found.name !== c.name) {
      throw new Error(`Category ${c.id} name is '${found.name}', expected '${c.name}' — update CATEGORIES constant`);
    }
    if (!found.is_active) {
      console.warn(`  WARNING: Category ${c.id} (${c.name}) is not active`);
    }
  }
  console.log('  Verified both communication categories belong to GSF tenant and names match.');
}

async function buildRoleMap(roleNamesNeeded) {
  const { data, error } = await supabase
    .from('role')
    .select('id, name')
    .eq('tenant_id', TENANT_ID);
  if (error) throw new Error(`role lookup failed: ${error.message}`);
  // Map: lc-trimmed name -> id
  const byName = new Map((data || []).map(r => [r.name.trim().toLowerCase(), r.id]));
  const roleMap = new Map(); // raw sheet role_name -> role_id
  const unmatched = [];
  for (const name of roleNamesNeeded) {
    const id = byName.get(name.trim().toLowerCase());
    if (!id) unmatched.push(name);
    else roleMap.set(name, id);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `role_name(s) in spreadsheet have no match in GSF roles: ${unmatched.map(n => `'${n}'`).join(', ')}. ` +
      `GSF roles: ${Array.from(byName.keys()).join(', ')}`,
    );
  }
  return roleMap;
}

// ---------- main ----------
async function main() {
  console.log(APPLY ? '=== LIVE RUN ===' : '=== DRY RUN ===');
  console.log('Tenant :', TENANT_ID);
  console.log('File   :', XLSX_PATH);
  if (LIMIT) console.log('Limit  :', LIMIT);
  console.log('');

  // 1. Parse spreadsheet
  let byEmail, rowCount, blank, skipped, dupes;
  try {
    ({ byEmail, rowCount, blank, skipped, dupes } = loadXlsx(XLSX_PATH));
  } catch (err) {
    console.error('[import-gsf-individuals] Failed to parse spreadsheet:', err.message);
    process.exit(1);
  }

  console.log('=== Spreadsheet parse ===');
  console.log(`Data rows read   : ${rowCount}`);
  console.log(`Unique emails    : ${byEmail.size}`);
  console.log(`Blank rows       : ${blank}`);
  console.log(`Duplicate emails (last-write-wins): ${dupes}`);
  console.log(`Skipped          : ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) console.log(`  [${s.reason}] ${s.value}`);
  }
  console.log('NOTE: "Iconnect unique id" column is informational only and is not stored.\n');

  // 2. Apply limit
  let emails = Array.from(byEmail.keys());
  if (LIMIT) emails = emails.slice(0, LIMIT);

  if (emails.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  // 3. Startup safety checks
  console.log('=== Startup checks ===');
  try {
    await verifyCategories();
  } catch (err) {
    console.error('[import-gsf-individuals] Category check failed:', err.message);
    process.exit(1);
  }

  // Collect all distinct role_names from the rows we'll process
  const roleNamesNeeded = new Set();
  for (const email of emails) {
    const rec = byEmail.get(email);
    if (rec.role_name) roleNamesNeeded.add(rec.role_name);
  }
  console.log(`  Distinct role names in sheet: ${Array.from(roleNamesNeeded).join(', ')}`);

  let roleMap;
  try {
    roleMap = await buildRoleMap(Array.from(roleNamesNeeded));
  } catch (err) {
    console.error('[import-gsf-individuals] Role mapping failed:', err.message);
    process.exit(1);
  }
  console.log(`  Role map built: ${roleMap.size} role(s).`);
  for (const [name, id] of roleMap) {
    console.log(`    '${name}' -> ${id}`);
  }
  console.log('');

  // 4. Load existing GSF members (by lowercased email)
  console.log('=== Loading existing members ===');
  const existingMembers = await fetchAllPaged(
    'member',
    'id, email, first_name, last_name, job_title, role_id',
    { tenant_id: TENANT_ID },
  );
  const existingByEmail = new Map();
  for (const m of existingMembers) {
    if (!m.email) continue;
    existingByEmail.set(m.email.toLowerCase().trim(), m);
  }
  console.log(`Existing members in GSF tenant : ${existingMembers.length}`);
  console.log(`Keyed by email                 : ${existingByEmail.size}`);
  console.log('');

  // 5. Classify members into inserts and updates
  const toInsert = []; // { id (new uuid), email, rec }
  const toUpdate = []; // { existing, diffs }
  const unchanged = []; // emails with no field change needed

  for (const email of emails) {
    const rec = byEmail.get(email);
    const roleId = rec.role_name ? roleMap.get(rec.role_name) : null;
    const existing = existingByEmail.get(email);

    if (!existing) {
      toInsert.push({ id: randomUUID(), email, rec, roleId });
    } else {
      const diffs = {};
      if (rec.first_name && rec.first_name !== existing.first_name) diffs.first_name = rec.first_name;
      if (rec.last_name && rec.last_name !== existing.last_name) diffs.last_name = rec.last_name;
      if (rec.job_title && rec.job_title !== existing.job_title) diffs.job_title = rec.job_title;
      if (roleId && roleId !== existing.role_id) diffs.role_id = roleId;
      if (Object.keys(diffs).length > 0) {
        toUpdate.push({ existing, diffs });
      } else {
        unchanged.push(email);
      }
    }
  }

  // 6. Load existing comm prefs for all existing members we will touch
  //    (toUpdate + unchanged; toInsert members are new so they have no existing prefs)
  const knownMemberIds = [
    ...toUpdate.map(u => u.existing.id),
    ...unchanged.map(email => existingByEmail.get(email).id),
  ];
  const existingComms = new Map(); // `${member_id}|${category_id}` -> { id, is_subscribed }
  for (let i = 0; i < knownMemberIds.length; i += 200) {
    const batch = knownMemberIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('member_communication_preference')
      .select('id, member_id, category_id, is_subscribed')
      .in('member_id', batch)
      .in('category_id', CATEGORIES.map(c => c.id));
    if (error) throw new Error(`member_communication_preference fetch failed: ${error.message}`);
    for (const row of (data || [])) {
      existingComms.set(`${row.member_id}|${row.category_id}`, row);
    }
  }

  // 7. Plan comm-pref writes
  const commUpserts = []; // rows to upsert (new or changed)
  let commUnchanged = 0;

  function planComms(memberId, rec) {
    const catValues = [
      { cat: CATEGORIES[0], value: rec.newsletter },
      { cat: CATEGORIES[1], value: rec.events },
    ];
    for (const { cat, value } of catValues) {
      const key = `${memberId}|${cat.id}`;
      const existing = existingComms.get(key);
      if (!existing) {
        commUpserts.push({ member_id: memberId, category_id: cat.id, is_subscribed: value, isNew: true });
      } else if (Boolean(existing.is_subscribed) !== Boolean(value)) {
        commUpserts.push({ member_id: memberId, category_id: cat.id, is_subscribed: value, isNew: false });
      } else {
        commUnchanged++;
      }
    }
  }

  // Plan for inserts (use their new IDs)
  for (const ins of toInsert) planComms(ins.id, ins.rec);
  // Plan for updates and unchanged existing members
  for (const upd of toUpdate) planComms(upd.existing.id, byEmail.get(upd.existing.email?.toLowerCase().trim()));
  for (const email of unchanged) planComms(existingByEmail.get(email).id, byEmail.get(email));

  const commNew = commUpserts.filter(c => c.isNew).length;
  const commChanged = commUpserts.filter(c => !c.isNew).length;

  // 8. Print plan
  console.log('=== Plan ===');
  console.log(`Members to create           : ${toInsert.length}`);
  console.log(`Members to update           : ${toUpdate.length}`);
  console.log(`Members unchanged           : ${unchanged.length}`);
  console.log(`Comm-pref rows to insert    : ${commNew}`);
  console.log(`Comm-pref rows to update    : ${commChanged}`);
  console.log(`Comm-pref rows unchanged    : ${commUnchanged}`);

  if (VERBOSE || toInsert.length <= 20) {
    if (toInsert.length > 0) {
      console.log('\nMembers to INSERT:');
      for (const ins of toInsert.slice(0, VERBOSE ? undefined : 20)) {
        console.log(`  [new] ${ins.email} | ${ins.rec.first_name} ${ins.rec.last_name} | role: ${ins.rec.role_name || '(none)'}`);
      }
    }
  }
  if (VERBOSE && toUpdate.length > 0) {
    console.log('\nMembers to UPDATE:');
    for (const upd of toUpdate) {
      console.log(`  [upd] ${upd.existing.email} | diffs: ${JSON.stringify(upd.diffs)}`);
    }
  }
  if (VERBOSE && commUpserts.length > 0) {
    console.log('\nComm-pref upserts:');
    for (const c of commUpserts.slice(0, 30)) {
      const catName = CATEGORIES.find(cat => cat.id === c.category_id)?.column ?? c.category_id;
      console.log(`  [${c.isNew ? 'new' : 'chg'}] member=${c.member_id} cat=${catName} is_subscribed=${c.is_subscribed}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    return;
  }

  // 9. Live writes
  console.log('\n=== Writing ===');
  let memberInsertOk = 0;
  let memberUpdateOk = 0;
  let commUpsertOk = 0;
  let errors = 0;
  const nowIso = new Date().toISOString();

  // Member inserts in batches of 200
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200).map(({ id, email, rec, roleId }) => ({
      id,
      tenant_id: TENANT_ID,
      email,
      first_name: rec.first_name,
      last_name: rec.last_name,
      job_title: rec.job_title,
      role_id: roleId,
    }));
    const { error } = await supabase.from('member').insert(batch);
    if (error) {
      console.error(`  Member insert batch [${i}..${i + batch.length}] failed:`, error.message);
      errors += batch.length;
    } else {
      memberInsertOk += batch.length;
      console.log(`  Member inserts: ${memberInsertOk}/${toInsert.length}`);
    }
  }

  // Member updates one-at-a-time (small set)
  for (const upd of toUpdate) {
    const { error } = await supabase
      .from('member')
      .update(upd.diffs)
      .eq('id', upd.existing.id)
      .eq('tenant_id', TENANT_ID);
    if (error) {
      console.error(`  Member update id=${upd.existing.id} failed:`, error.message);
      errors++;
    } else {
      memberUpdateOk++;
    }
  }
  if (toUpdate.length > 0) console.log(`  Member updates: ${memberUpdateOk}/${toUpdate.length}`);

  // Comm-pref upserts in batches of 200
  for (let i = 0; i < commUpserts.length; i += 200) {
    const batch = commUpserts.slice(i, i + 200).map(c => ({
      member_id: c.member_id,
      category_id: c.category_id,
      is_subscribed: c.is_subscribed,
      tenant_id: TENANT_ID,
      updated_at: nowIso,
    }));
    const { error } = await supabase
      .from('member_communication_preference')
      .upsert(batch, { onConflict: 'member_id,category_id' });
    if (error) {
      console.error(`  Comm-pref upsert batch [${i}..${i + batch.length}] failed:`, error.message);
      errors += batch.length;
    } else {
      commUpsertOk += batch.length;
    }
  }
  if (commUpserts.length > 0) console.log(`  Comm-pref upserts: ${commUpsertOk}/${commUpserts.length}`);

  console.log('\n=== SUMMARY ===');
  console.log(`Members created   : ${memberInsertOk}`);
  console.log(`Members updated   : ${memberUpdateOk}`);
  console.log(`Members unchanged : ${unchanged.length}`);
  console.log(`Comm-pref upserts : ${commUpsertOk} (${commNew} new, ${commChanged} changed)`);
  console.log(`Comm-pref unchanged: ${commUnchanged}`);
  console.log(`Errors            : ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('[import-gsf-individuals] Fatal:', err.message || err);
  process.exit(1);
});
