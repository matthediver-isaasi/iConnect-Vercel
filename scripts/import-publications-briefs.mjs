import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const CSV_PATH = './attached_assets/publicationsNoCS_1776675360214.csv';

const CONTRIBUTOR_TYPE_MAP = {
  'gfi team': 'gfi',
};

// Resolve a CSV status label (e.g. "Submitted") to the internal stage key
// configured for the tenant in article_brief_settings.stages.
async function buildStatusResolver(supabase) {
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

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL/SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

function parseDmy(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    // Maybe already ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    return null;
  }
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

async function main() {
  const csv = readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Read ${rows.length} CSV rows`);

  // Collect unique writer/editor emails
  const emailSet = new Set();
  for (const r of rows) {
    if (r['Writer']) emailSet.add(r['Writer'].trim().toLowerCase());
    if (r['Editor']) emailSet.add(r['Editor'].trim().toLowerCase());
  }
  const emails = [...emailSet].filter(Boolean);
  console.log(`Looking up ${emails.length} unique emails:`, emails);

  const { data: members, error: memErr } = await supabase
    .from('member')
    .select('id, email')
    .eq('tenant_id', TENANT_ID)
    .in('email', emails);
  if (memErr) throw memErr;
  const memberByEmail = new Map();
  for (const m of members || []) {
    const key = m.email.toLowerCase();
    if (memberByEmail.has(key)) {
      console.warn(`Ambiguous member match for ${key} within tenant — skipping`);
      memberByEmail.set(key, null);
    } else {
      memberByEmail.set(key, m.id);
    }
  }
  console.log(`Resolved ${[...memberByEmail.values()].filter(Boolean).length}/${emails.length} members within tenant`);

  const resolveStatus = await buildStatusResolver(supabase);

  // Fetch existing briefs in tenant by title
  const { data: existing, error: exErr } = await supabase
    .from('article_brief')
    .select('title')
    .eq('tenant_id', TENANT_ID);
  if (exErr) throw exErr;
  const existingTitles = new Set((existing || []).map((b) => b.title.trim().toLowerCase()));
  console.log(`Tenant currently has ${existingTitles.size} briefs`);

  const inserted = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // header + 1
    const title = (r['Title'] || '').trim();
    if (!title) {
      skipped.push({ rowNum, title, reason: 'empty title' });
      continue;
    }

    const writerEmail = (r['Writer'] || '').trim().toLowerCase();
    const editorEmail = (r['Editor'] || '').trim().toLowerCase();
    const writerId = writerEmail ? memberByEmail.get(writerEmail) : null;
    const editorId = editorEmail ? memberByEmail.get(editorEmail) : null;

    if (writerEmail && !writerId) {
      skipped.push({ rowNum, title, reason: `writer not found: ${writerEmail}` });
      continue;
    }
    if (editorEmail && !editorId) {
      skipped.push({ rowNum, title, reason: `editor not found: ${editorEmail}` });
      continue;
    }

    if (existingTitles.has(title.toLowerCase())) {
      skipped.push({ rowNum, title, reason: 'title already exists' });
      continue;
    }

    const statusLabel = (r['Status'] || '').trim();
    const status = resolveStatus(statusLabel);
    if (statusLabel && !status) {
      skipped.push({ rowNum, title, reason: `unknown status: ${statusLabel}` });
      continue;
    }

    const contribRaw = (r['Contributor Type'] || '').trim().toLowerCase();
    const contributorType = CONTRIBUTOR_TYPE_MAP[contribRaw] || (contribRaw || null);

    const payload = {
      title,
      category: (r['Category'] || '').trim() || null,
      sla: (r['SLA'] || '').trim() || null,
      contract: (r['Contract'] || '').trim() || null,
      deadline: parseDmy(r['Submission Deadline']),
      writer_deadline: parseDmy(r['Writer Deadline']),
      editor_deadline: parseDmy(r['Editor Deadline']),
      status,
      assigned_writer_id: writerId || null,
      review_owner_id: editorId || null,
      notes: (r['Notes'] || '').trim() || null,
      contributor_type: contributorType,
      tenant_id: TENANT_ID,
    };

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
  console.log(`CSV rows:    ${rows.length}`);
  console.log(`Inserted:    ${inserted.length}`);
  console.log(`Skipped:     ${skipped.length}`);
  if (skipped.length > 0) {
    console.log('\nSkipped rows:');
    for (const s of skipped) {
      console.log(`  row ${s.rowNum} "${s.title}" — ${s.reason}`);
    }
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
