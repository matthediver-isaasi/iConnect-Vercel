// One-off import: "Q3 data" sheet of the Q3 publications workbook into
// article_brief for the GFI tenant. Modelled on import-publications-briefs.mjs
// and import-publications-external-writer-briefs.mjs.
//
// Usage: node scripts/import-q3-publications-briefs.mjs [--dry-run]
//
// - Internal rows (External Writer = "No"): writer + editor resolved from the
//   member table by case-insensitive first/last name within the tenant.
// - External rows (External Writer = "Yes"): external_writer upserted by
//   lowercased email; editor still resolved from the member table.
// - Deadline cells are Excel serial numbers, converted to ISO dates.
// - Idempotent: titles that already exist for the tenant are skipped.
// - "External Writer NDA" has no corresponding column; values reported only.

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const XLSX_PATH = './attached_assets/Publications_data_import_file_Q3_1784121746789.xlsx';
const SHEET_NAME = 'Q3 data';
const DRY_RUN = process.argv.includes('--dry-run');

const CONTRIBUTOR_TYPE_MAP = {
  'gfi team': 'gfi',
  paid: 'paid',
};

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL/DEST_SUPABASE_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// Excel serial (1900 date system) -> ISO yyyy-mm-dd
function excelSerialToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d+$/.test(trimmed)) value = Number(trimmed);
    else return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Excel epoch 1899-12-30 (accounts for the fake 1900 leap day)
  const ms = Math.round((value - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function yesNo(value) {
  return String(value || '').trim().toLowerCase() === 'yes';
}

async function buildStatusResolver() {
  const { data, error } = await supabase
    .from('article_brief_settings')
    .select('stages')
    .eq('tenant_id', TENANT_ID)
    .maybeSingle();
  if (error) throw error;
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  const labelToKey = new Map();
  const keyToKey = new Map();
  for (const s of stages) {
    if (s?.label) labelToKey.set(String(s.label).trim().toLowerCase(), s.key);
    if (s?.key) keyToKey.set(String(s.key).trim().toLowerCase(), s.key);
  }
  return (rawLabel) => {
    const v = (rawLabel || '').trim().toLowerCase();
    if (!v) return null;
    return labelToKey.get(v) || keyToKey.get(v) || null;
  };
}

async function resolveMemberByName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { id: null, reason: 'not a first+last name' };
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  const { data, error } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('tenant_id', TENANT_ID)
    .ilike('first_name', first)
    .ilike('last_name', last);
  if (error) throw error;
  if (!data || data.length === 0) return { id: null, reason: 'no member match' };
  if (data.length > 1) return { id: null, reason: `ambiguous (${data.length} matches)` };
  return { id: data[0].id, reason: null };
}

async function upsertExternalWriter({ first_name, last_name, email }) {
  const normEmail = email.trim().toLowerCase();
  const { data: existing, error: selErr } = await supabase
    .from('external_writer')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('email', normEmail)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return { id: existing.id, created: false };
  if (DRY_RUN) return { id: `dry-run-${normEmail}`, created: true };
  const { data: created, error: insErr } = await supabase
    .from('external_writer')
    .insert({ tenant_id: TENANT_ID, first_name, last_name, email: normEmail })
    .select('id')
    .single();
  if (insErr) throw insErr;
  return { id: created.id, created: true };
}

async function main() {
  console.log(DRY_RUN ? '*** DRY RUN — no writes ***' : '*** LIVE RUN ***');
  const wb = XLSX.readFile(XLSX_PATH);
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  console.log(`Read ${rows.length} rows from "${SHEET_NAME}"`);

  const resolveStatus = await buildStatusResolver();

  // Pre-resolve internal member names (writers + editors), cached
  const nameCache = new Map();
  const unresolvedNames = new Map();
  async function getMemberId(name) {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    if (nameCache.has(key)) return nameCache.get(key);
    const { id, reason } = await resolveMemberByName(name);
    nameCache.set(key, id);
    if (!id) unresolvedNames.set(name.trim(), reason);
    return id;
  }

  // Pre-upsert external writers (dedup by email)
  const writerCache = new Map();
  let writersCreated = 0;
  let writersMatched = 0;
  for (const r of rows) {
    if (!yesNo(r['External Writer'])) continue;
    const email = String(r['External Writer email'] || '').trim().toLowerCase();
    if (!email || writerCache.has(email)) continue;
    const result = await upsertExternalWriter({
      first_name: String(r['External Writer first name'] || '').trim(),
      last_name: String(r['External Writer last name'] || '').trim(),
      email,
    });
    writerCache.set(email, result.id);
    if (result.created) writersCreated++; else writersMatched++;
    console.log(`  ${result.created ? 'created' : 'matched'} external writer ${email} -> ${result.id}`);
  }

  // Existing brief titles (paginate past PostgREST's 1000-row cap)
  const existingTitles = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('article_brief')
      .select('title')
      .eq('tenant_id', TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    for (const b of data || []) existingTitles.add(b.title.trim().toLowerCase());
    if (!data || data.length < 1000) break;
  }
  console.log(`Tenant currently has ${existingTitles.size} distinct brief titles`);

  const inserted = [];
  const skipped = [];
  const ndaValues = new Map();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2;
    const title = String(r['Title'] || '').trim();
    if (!title) {
      skipped.push({ rowNum, title, reason: 'empty title' });
      continue;
    }

    const nda = String(r['External Writer NDA'] || '').trim();
    if (nda) ndaValues.set(nda, (ndaValues.get(nda) || 0) + 1);

    if (existingTitles.has(title.toLowerCase())) {
      skipped.push({ rowNum, title, reason: 'title already exists' });
      continue;
    }

    const isExternal = yesNo(r['External Writer']);

    const editorName = String(r['Editor'] || '').trim();
    const editorId = editorName ? await getMemberId(editorName) : null;
    if (editorName && !editorId) {
      skipped.push({ rowNum, title, reason: `editor not resolved: ${editorName}` });
      continue;
    }

    let writerId = null;
    let externalWriterId = null;
    if (isExternal) {
      const email = String(r['External Writer email'] || '').trim().toLowerCase();
      externalWriterId = email ? writerCache.get(email) : null;
      if (!externalWriterId) {
        skipped.push({ rowNum, title, reason: `external writer not resolved: ${email || '(no email)'}` });
        continue;
      }
    } else {
      const writerName = String(r['Writer'] || '').trim();
      writerId = writerName ? await getMemberId(writerName) : null;
      if (writerName && !writerId) {
        skipped.push({ rowNum, title, reason: `writer not resolved: ${writerName}` });
        continue;
      }
    }

    const statusLabel = String(r['Status'] || '').trim();
    const status = resolveStatus(statusLabel);
    if (statusLabel && !status) {
      skipped.push({ rowNum, title, reason: `unknown status: ${statusLabel}` });
      continue;
    }

    const contribRaw = String(r['Contributor Type'] || '').trim().toLowerCase();
    const contributorType = CONTRIBUTOR_TYPE_MAP[contribRaw] || (contribRaw || null);

    const payload = {
      title,
      category: String(r['Category'] || '').trim() || null,
      sla: String(r['SLA'] || '').trim() || null,
      contract: String(r['Contract'] || '').trim() || null,
      deadline: excelSerialToIso(r['Submission Deadline']),
      writer_deadline: excelSerialToIso(r['Writer Deadline']),
      editor_deadline: excelSerialToIso(r['Editor Deadline']),
      status,
      assigned_writer_id: writerId,
      external_writer_id: externalWriterId,
      review_owner_id: editorId || null,
      notes: String(r['Notes'] || '').trim() || null,
      contributor_type: contributorType,
      case_study_required: yesNo(r['Case Study']),
      copyright_required: yesNo(r['Member Copyright agreement']),
      tenant_id: TENANT_ID,
    };

    if (DRY_RUN) {
      inserted.push({ id: '(dry)', title });
      existingTitles.add(title.toLowerCase());
      continue;
    }

    const { data: insertedRow, error: insErr } = await supabase
      .from('article_brief')
      .insert(payload)
      .select('id, title')
      .single();
    if (insErr) {
      skipped.push({ rowNum, title, reason: `insert failed: ${insErr.message}` });
      continue;
    }
    inserted.push(insertedRow);
    existingTitles.add(title.toLowerCase());
  }

  console.log('\n========= IMPORT SUMMARY =========');
  console.log(`Sheet rows:              ${rows.length}`);
  console.log(`Briefs inserted:         ${inserted.length}`);
  console.log(`Briefs skipped:          ${skipped.length}`);
  console.log(`External writers created: ${writersCreated}`);
  console.log(`External writers matched: ${writersMatched}`);
  if (unresolvedNames.size > 0) {
    console.log('\nUnresolved member names:');
    for (const [name, reason] of unresolvedNames) console.log(`  ${name} — ${reason}`);
  }
  if (ndaValues.size > 0) {
    console.log('\n"External Writer NDA" values (no matching column; NOT imported):');
    for (const [v, n] of ndaValues) console.log(`  "${v}": ${n} rows`);
  }
  if (skipped.length > 0) {
    console.log('\nSkipped rows:');
    for (const s of skipped) console.log(`  row ${s.rowNum} "${s.title}" — ${s.reason}`);
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
