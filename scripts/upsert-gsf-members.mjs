// One-off bulk-load of the GSF members CSV into tenant
// 21296ad6-1350-483a-a90c-1b06ece70501. Idempotent: re-running it after a
// successful run produces zero changes.
//
// Per-row writes:
//   - upsert member by (tenant_id, organization_id, lower(email))
//   - upsert ceo_flag + gsf_board_member into member_preference_value
//   - upsert two member_communication_preference rows (Community Newsletter,
//     Event Updates) with is_subscribed from the boolean columns
//
// Usage:
//   node scripts/upsert-gsf-members.mjs --dry-run [--limit=N] [--file=path]
//   node scripts/upsert-gsf-members.mjs            [--limit=N] [--file=path]
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const FIELD_NAME_CEO = 'ceo_flag';
const FIELD_NAME_BOARD = 'gsf_board_member';
const CATEGORY_NEWSLETTER = 'f4522519-a535-46b4-8685-d6e2ff22b6f5';
const CATEGORY_EVENTS = '478810ca-9d68-435b-8eba-32728cb2dee7';
const DEFAULT_FILE = 'attached_assets/gsfMemberCleaned_1779873272134.csv';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const fileArg = args.find(a => a.startsWith('--file='));
const CSV_PATH = fileArg ? fileArg.split('=')[1] : DEFAULT_FILE;

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

// ---------- helpers ----------
const unexpectedBoolValues = { CEO: new Set(), 'Community Newsletter (Snapshot)': new Set(), 'Event Updates': new Set(), 'GSF Board Member': new Set(), 'member.login_enabled': new Set() };

function parseBool(raw, colLabel) {
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim();
  if (v === '') return false;
  const lower = v.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(lower)) return true;
  if (['false', '0', 'no', 'n'].includes(lower)) return false;
  unexpectedBoolValues[colLabel]?.add(v);
  return false;
}

function emptyToNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

async function fetchAllPaged(table, select, filters = {}) {
  const out = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`Failed paged fetch from ${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log('Tenant:', TENANT_ID);
  console.log('CSV   :', CSV_PATH);
  if (LIMIT) console.log('Limit :', LIMIT);
  console.log('');

  // --- Step 1: resolve preference fields + categories ---
  const { data: prefFields, error: pfErr } = await supabase
    .from('preference_field')
    .select('id, name')
    .eq('tenant_id', TENANT_ID)
    .in('name', [FIELD_NAME_CEO, FIELD_NAME_BOARD]);
  if (pfErr) { console.error('preference_field lookup failed:', pfErr); process.exit(1); }
  const ceoField = prefFields?.find(p => p.name === FIELD_NAME_CEO);
  const boardField = prefFields?.find(p => p.name === FIELD_NAME_BOARD);
  if (!ceoField) { console.error(`Missing preference_field name='${FIELD_NAME_CEO}' in tenant`); process.exit(1); }
  if (!boardField) { console.error(`Missing preference_field name='${FIELD_NAME_BOARD}' in tenant`); process.exit(1); }

  const { data: cats, error: catErr } = await supabase
    .from('communication_category')
    .select('id, name, tenant_id')
    .in('id', [CATEGORY_NEWSLETTER, CATEGORY_EVENTS]);
  if (catErr) { console.error('communication_category lookup failed:', catErr); process.exit(1); }
  const catNews = cats?.find(c => c.id === CATEGORY_NEWSLETTER);
  const catEvent = cats?.find(c => c.id === CATEGORY_EVENTS);
  if (!catNews || catNews.tenant_id !== TENANT_ID) { console.error(`Missing/wrong-tenant category ${CATEGORY_NEWSLETTER}`); process.exit(1); }
  if (!catEvent || catEvent.tenant_id !== TENANT_ID) { console.error(`Missing/wrong-tenant category ${CATEGORY_EVENTS}`); process.exit(1); }

  console.log('Resolved:');
  console.log('  ceo_flag           ->', ceoField.id);
  console.log('  gsf_board_member   ->', boardField.id);
  console.log('  Newsletter category->', catNews.id);
  console.log('  Events category    ->', catEvent.id);
  console.log('');

  // --- Step 2: pre-load org + role ids for tenant ---
  const orgs = await fetchAllPaged('organization', 'id', { tenant_id: TENANT_ID });
  const orgIds = new Set(orgs.map(o => o.id));
  const roles = await fetchAllPaged('role', 'id', { tenant_id: TENANT_ID });
  const roleIds = new Set(roles.map(r => r.id));
  console.log(`Tenant orgs: ${orgIds.size}, roles: ${roleIds.size}`);

  // --- Step 3: pre-load existing members ---
  const existingMembers = await fetchAllPaged(
    'member',
    'id, email, organization_id, role_id, first_name, last_name, job_title, login_enabled',
    { tenant_id: TENANT_ID }
  );
  const memberKey = (orgId, emailLower) => `${orgId}|${emailLower}`;
  const existingByKey = new Map();
  for (const m of existingMembers) {
    if (!m.organization_id || !m.email) continue;
    existingByKey.set(memberKey(m.organization_id, m.email.toLowerCase().trim()), m);
  }
  console.log(`Existing members in tenant: ${existingMembers.length} (keyed: ${existingByKey.size})`);
  console.log('');

  // --- Step 4: parse CSV ---
  const raw = readFileSync(CSV_PATH);
  const records = parse(raw, { columns: true, bom: true, skip_empty_lines: true, trim: false });
  console.log(`CSV rows parsed: ${records.length}`);

  const groups = new Map(); // key -> aggregated row
  const skipsMissingOrg = [];
  const skipsMissingRole = [];
  const skipsBlankKey = [];

  const COL = {
    org: 'member.organizarion_id',
    first: 'member.first_name',
    last: 'member.last_name',
    email: 'member.email',
    role: 'role.id',
    job: 'member.job_title',
    ceo: 'CEO',
    news: 'Community Newsletter (Snapshot)',
    events: 'Event Updates',
    board: 'GSF Board Member',
    login: 'member.login_enabled',
  };

  let processedRowCount = 0;
  for (const r of records) {
    if (LIMIT && processedRowCount >= LIMIT) break;
    processedRowCount++;

    const orgId = emptyToNull(r[COL.org]);
    const emailRaw = emptyToNull(r[COL.email]);
    if (!orgId || !emailRaw) {
      skipsBlankKey.push({ row: processedRowCount, reason: 'missing organization_id or email' });
      continue;
    }
    const emailLower = emailRaw.toLowerCase();
    const roleId = emptyToNull(r[COL.role]);

    if (!orgIds.has(orgId)) {
      skipsMissingOrg.push({ row: processedRowCount, email: emailLower, organization_id: orgId });
      continue;
    }
    if (roleId && !roleIds.has(roleId)) {
      skipsMissingRole.push({ row: processedRowCount, email: emailLower, role_id: roleId });
      continue;
    }

    const key = memberKey(orgId, emailLower);
    const rowData = {
      organization_id: orgId,
      email: emailLower,
      first_name: emptyToNull(r[COL.first]),
      last_name: emptyToNull(r[COL.last]),
      job_title: emptyToNull(r[COL.job]),
      role_id: roleId,
      login_enabled: parseBool(r[COL.login], 'member.login_enabled'),
      ceo: parseBool(r[COL.ceo], 'CEO'),
      board: parseBool(r[COL.board], 'GSF Board Member'),
      news: parseBool(r[COL.news], 'Community Newsletter (Snapshot)'),
      events: parseBool(r[COL.events], 'Event Updates'),
    };

    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, rowData);
    } else {
      // last non-empty wins for member fields, role_id from last row,
      // login_enabled from last row, preferences ORed together
      prev.first_name = rowData.first_name ?? prev.first_name;
      prev.last_name = rowData.last_name ?? prev.last_name;
      prev.job_title = rowData.job_title ?? prev.job_title;
      prev.role_id = rowData.role_id; // last wins (incl. null)
      prev.login_enabled = rowData.login_enabled;
      prev.ceo = prev.ceo || rowData.ceo;
      prev.board = prev.board || rowData.board;
      prev.news = prev.news || rowData.news;
      prev.events = prev.events || rowData.events;
    }
  }

  console.log(`Rows skipped — blank key       : ${skipsBlankKey.length}`);
  console.log(`Rows skipped — unknown org     : ${skipsMissingOrg.length}`);
  console.log(`Rows skipped — unknown role    : ${skipsMissingRole.length}`);
  console.log(`Distinct (org, email) groups   : ${groups.size}`);
  console.log('');

  // --- Step 5: classify inserts/updates ---
  const toInsert = [];
  const toUpdate = [];
  for (const [key, g] of groups) {
    const existing = existingByKey.get(key);
    if (!existing) {
      toInsert.push({ key, g, id: randomUUID() });
    } else {
      const diffs = {};
      const checks = ['first_name', 'last_name', 'job_title', 'role_id'];
      for (const k of checks) {
        const newVal = g[k];
        const oldVal = existing[k];
        if ((newVal ?? null) !== (oldVal ?? null)) diffs[k] = newVal;
      }
      if (g.email !== (existing.email || '').toLowerCase().trim()) diffs.email = g.email;
      if (Boolean(existing.login_enabled) !== Boolean(g.login_enabled)) diffs.login_enabled = g.login_enabled;
      if (Object.keys(diffs).length > 0) toUpdate.push({ key, id: existing.id, g, diffs });
    }
  }

  // --- Step 6: pre-load existing pref + comm rows for change detection ---
  const memberIdsKnown = [
    ...existingMembers.filter(m => m.organization_id && m.email && groups.has(memberKey(m.organization_id, m.email.toLowerCase().trim()))).map(m => m.id),
  ];

  async function fetchExistingPrefs(memberIds) {
    if (memberIds.length === 0) return new Map();
    const out = new Map();
    const pageSize = 100;
    for (let i = 0; i < memberIds.length; i += pageSize) {
      const batch = memberIds.slice(i, i + pageSize);
      const { data, error } = await supabase
        .from('member_preference_value')
        .select('id, member_id, field_id, value')
        .in('member_id', batch)
        .in('field_id', [ceoField.id, boardField.id]);
      if (error) throw new Error(`pref fetch failed: ${error.message}`);
      for (const row of data) out.set(`${row.member_id}|${row.field_id}`, row);
    }
    return out;
  }
  async function fetchExistingComms(memberIds) {
    if (memberIds.length === 0) return new Map();
    const out = new Map();
    const pageSize = 100;
    for (let i = 0; i < memberIds.length; i += pageSize) {
      const batch = memberIds.slice(i, i + pageSize);
      const { data, error } = await supabase
        .from('member_communication_preference')
        .select('id, member_id, category_id, is_subscribed')
        .in('member_id', batch)
        .in('category_id', [catNews.id, catEvent.id]);
      if (error) throw new Error(`comm fetch failed: ${error.message}`);
      for (const row of data) out.set(`${row.member_id}|${row.category_id}`, row);
    }
    return out;
  }

  const existingPrefs = await fetchExistingPrefs(memberIdsKnown);
  const existingComms = await fetchExistingComms(memberIdsKnown);

  // --- Step 7: compute pref / comm writes ---
  const prefWrites = []; // { member_id, field_id, value, existingId? }
  const commWrites = []; // { member_id, category_id, is_subscribed, existingId? }

  for (const ins of toInsert) {
    // new member -> always insert both prefs + both comms
    prefWrites.push({ member_id: ins.id, field_id: ceoField.id, value: ins.g.ceo ? 'true' : 'false' });
    prefWrites.push({ member_id: ins.id, field_id: boardField.id, value: ins.g.board ? 'true' : 'false' });
    commWrites.push({ member_id: ins.id, category_id: catNews.id, is_subscribed: ins.g.news });
    commWrites.push({ member_id: ins.id, category_id: catEvent.id, is_subscribed: ins.g.events });
  }
  for (const [key, g] of groups) {
    const existing = existingByKey.get(key);
    if (!existing) continue;
    const memId = existing.id;
    const wantPairs = [
      { field_id: ceoField.id, value: g.ceo ? 'true' : 'false' },
      { field_id: boardField.id, value: g.board ? 'true' : 'false' },
    ];
    for (const w of wantPairs) {
      const cur = existingPrefs.get(`${memId}|${w.field_id}`);
      if (!cur) prefWrites.push({ member_id: memId, field_id: w.field_id, value: w.value });
      else if ((cur.value ?? '') !== w.value) prefWrites.push({ member_id: memId, field_id: w.field_id, value: w.value, existingId: cur.id });
    }
    const wantComms = [
      { category_id: catNews.id, is_subscribed: g.news },
      { category_id: catEvent.id, is_subscribed: g.events },
    ];
    for (const w of wantComms) {
      const cur = existingComms.get(`${memId}|${w.category_id}`);
      if (!cur) commWrites.push({ member_id: memId, category_id: w.category_id, is_subscribed: w.is_subscribed });
      else if (Boolean(cur.is_subscribed) !== Boolean(w.is_subscribed)) commWrites.push({ member_id: memId, category_id: w.category_id, is_subscribed: w.is_subscribed, existingId: cur.id });
    }
  }

  const prefInserts = prefWrites.filter(p => !p.existingId);
  const prefUpdates = prefWrites.filter(p => p.existingId);
  const commInserts = commWrites.filter(c => !c.existingId);
  const commUpdates = commWrites.filter(c => c.existingId);

  console.log('=== Planned changes ===');
  console.log(`Member inserts            : ${toInsert.length}`);
  console.log(`Member updates            : ${toUpdate.length}`);
  console.log(`Preference inserts        : ${prefInserts.length}`);
  console.log(`Preference updates        : ${prefUpdates.length}`);
  console.log(`Comm-pref inserts         : ${commInserts.length}`);
  console.log(`Comm-pref updates         : ${commUpdates.length}`);
  console.log('');

  for (const [col, set] of Object.entries(unexpectedBoolValues)) {
    if (set.size > 0) console.log(`Unexpected bool values in "${col}":`, Array.from(set).slice(0, 10));
  }

  if (DRY_RUN) {
    const sample = (arr, n = 10) => arr.slice(0, n);
    if (skipsMissingOrg.length) {
      console.log('\nFirst unknown-org skips:');
      sample(skipsMissingOrg).forEach(s => console.log(' ', s));
    }
    if (skipsMissingRole.length) {
      console.log('\nFirst unknown-role skips:');
      sample(skipsMissingRole).forEach(s => console.log(' ', s));
    }
    if (skipsBlankKey.length) {
      console.log('\nFirst blank-key skips:');
      sample(skipsBlankKey).forEach(s => console.log(' ', s));
    }
    if (toInsert.length) {
      console.log('\nSample inserts:');
      sample(toInsert).forEach(i => console.log(' ', i.key, '->', i.id, i.g.first_name, i.g.last_name));
    }
    if (toUpdate.length) {
      console.log('\nSample updates:');
      sample(toUpdate).forEach(u => console.log(' ', u.key, 'id=', u.id, 'diffs=', u.diffs));
    }
    console.log('\nDRY RUN complete. No changes made.');
    return;
  }

  // --- Step 8: live writes ---
  let memberInsertOk = 0, memberUpdateOk = 0, prefInsertOk = 0, prefUpdateOk = 0, commInsertOk = 0, commUpdateOk = 0;

  // Member inserts in batches of 100
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100).map(({ id, g }) => ({
      id,
      tenant_id: TENANT_ID,
      organization_id: g.organization_id,
      email: g.email,
      first_name: g.first_name,
      last_name: g.last_name,
      job_title: g.job_title,
      role_id: g.role_id,
      login_enabled: g.login_enabled,
    }));
    const { error } = await supabase.from('member').insert(batch);
    if (error) { console.error('Member insert batch failed:', error); process.exit(1); }
    memberInsertOk += batch.length;
    if ((i / 100) % 5 === 0) console.log(`  member inserts: ${memberInsertOk}/${toInsert.length}`);
  }

  // Member updates one at a time (small set; per-row diff)
  for (const u of toUpdate) {
    const patch = { ...u.diffs };
    const { error } = await supabase.from('member').update(patch).eq('id', u.id).eq('tenant_id', TENANT_ID);
    if (error) { console.error('Member update failed for', u.id, error); process.exit(1); }
    memberUpdateOk++;
  }
  console.log(`  member updates: ${memberUpdateOk}/${toUpdate.length}`);

  // Pref inserts batched
  for (let i = 0; i < prefInserts.length; i += 200) {
    const batch = prefInserts.slice(i, i + 200).map(p => ({ member_id: p.member_id, field_id: p.field_id, value: p.value }));
    const { error } = await supabase.from('member_preference_value').insert(batch);
    if (error) { console.error('Pref insert batch failed:', error); process.exit(1); }
    prefInsertOk += batch.length;
  }
  console.log(`  pref inserts: ${prefInsertOk}/${prefInserts.length}`);

  for (const p of prefUpdates) {
    const { error } = await supabase.from('member_preference_value').update({ value: p.value }).eq('id', p.existingId);
    if (error) { console.error('Pref update failed for', p.existingId, error); process.exit(1); }
    prefUpdateOk++;
  }
  console.log(`  pref updates: ${prefUpdateOk}/${prefUpdates.length}`);

  for (let i = 0; i < commInserts.length; i += 200) {
    const batch = commInserts.slice(i, i + 200).map(c => ({
      member_id: c.member_id,
      category_id: c.category_id,
      is_subscribed: c.is_subscribed,
      tenant_id: TENANT_ID,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('member_communication_preference').insert(batch);
    if (error) { console.error('Comm insert batch failed:', error); process.exit(1); }
    commInsertOk += batch.length;
  }
  console.log(`  comm inserts: ${commInsertOk}/${commInserts.length}`);

  for (const c of commUpdates) {
    const { error } = await supabase.from('member_communication_preference').update({ is_subscribed: c.is_subscribed, updated_at: new Date().toISOString() }).eq('id', c.existingId);
    if (error) { console.error('Comm update failed for', c.existingId, error); process.exit(1); }
    commUpdateOk++;
  }
  console.log(`  comm updates: ${commUpdateOk}/${commUpdates.length}`);

  console.log('\n=== SUMMARY ===');
  console.log('Member inserts            :', memberInsertOk);
  console.log('Member updates            :', memberUpdateOk);
  console.log('Preference inserts        :', prefInsertOk);
  console.log('Preference updates        :', prefUpdateOk);
  console.log('Comm-pref inserts         :', commInsertOk);
  console.log('Comm-pref updates         :', commUpdateOk);
  console.log('Skipped (unknown org)     :', skipsMissingOrg.length);
  console.log('Skipped (unknown role)    :', skipsMissingRole.length);
  console.log('Skipped (blank key)       :', skipsBlankKey.length);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
