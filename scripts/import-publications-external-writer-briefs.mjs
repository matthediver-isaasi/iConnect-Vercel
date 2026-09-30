import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const CSV_PATH = './attached_assets/publicationsExternalWriter_1776677753142.csv';

const CONTRIBUTOR_TYPE_MAP = {
  paid: 'paid',
  'gfi team': 'gfi',
};

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
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    return null;
  }
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

async function resolveEditorByName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  const { data, error } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('tenant_id', TENANT_ID)
    .ilike('first_name', first)
    .ilike('last_name', last);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    console.warn(`Ambiguous editor match for "${fullName}" — found ${data.length} members; using first.`);
  }
  return data[0].id;
}

async function upsertExternalWriter({ first_name, last_name, email }) {
  const normEmail = email.trim().toLowerCase();
  const { data: existing, error: selErr } = await supabase
    .from('external_writer')
    .select('id, first_name, last_name, email')
    .eq('tenant_id', TENANT_ID)
    .eq('email', normEmail)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return { id: existing.id, created: false };

  const { data: created, error: insErr } = await supabase
    .from('external_writer')
    .insert({
      tenant_id: TENANT_ID,
      first_name,
      last_name,
      email: normEmail,
    })
    .select('id')
    .single();
  if (insErr) throw insErr;
  return { id: created.id, created: true };
}

async function main() {
  const csv = readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Read ${rows.length} CSV rows`);

  const resolveStatus = await buildStatusResolver(supabase);

  // Pre-resolve editor name(s)
  const editorCache = new Map();
  async function getEditorId(name) {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    if (editorCache.has(key)) return editorCache.get(key);
    const id = await resolveEditorByName(name);
    editorCache.set(key, id);
    return id;
  }

  // Pre-upsert external writers (dedup by email)
  const writerCache = new Map();
  let writersCreated = 0;
  let writersReused = 0;
  for (const r of rows) {
    const email = (r['External Writer email'] || '').trim().toLowerCase();
    if (!email || writerCache.has(email)) continue;
    const result = await upsertExternalWriter({
      first_name: (r['External Writer first name'] || '').trim(),
      last_name: (r['External Writer last name'] || '').trim(),
      email,
    });
    writerCache.set(email, result.id);
    if (result.created) writersCreated++; else writersReused++;
    console.log(`  ${result.created ? 'created' : 'reused'} external writer ${email} -> ${result.id}`);
  }

  // Existing brief titles
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
    const rowNum = i + 2;
    const title = (r['Title'] || '').trim();
    if (!title) {
      skipped.push({ rowNum, title, reason: 'empty title' });
      continue;
    }

    if (existingTitles.has(title.toLowerCase())) {
      skipped.push({ rowNum, title, reason: 'title already exists' });
      continue;
    }

    const editorName = (r['Editor'] || '').trim();
    const editorId = editorName ? await getEditorId(editorName) : null;
    if (editorName && !editorId) {
      skipped.push({ rowNum, title, reason: `editor not found: ${editorName}` });
      continue;
    }

    const writerEmail = (r['External Writer email'] || '').trim().toLowerCase();
    const externalWriterId = writerEmail ? writerCache.get(writerEmail) : null;
    if (writerEmail && !externalWriterId) {
      skipped.push({ rowNum, title, reason: `external writer not found: ${writerEmail}` });
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

    const ndaFlag = (r['External Writer NDA'] || '').trim();
    const noteParts = [];
    if (ndaFlag) noteParts.push(`External Writer NDA: ${ndaFlag}`);
    const notes = noteParts.length > 0 ? noteParts.join('\n') : null;

    const payload = {
      title,
      category: (r['Category'] || '').trim() || null,
      sla: (r['SLA'] || '').trim() || null,
      contract: (r['Contract'] || '').trim() || null,
      deadline: parseDmy(r['Submission Deadline']),
      writer_deadline: parseDmy(r['Writer Deadline']),
      editor_deadline: parseDmy(r['Editor Deadline']),
      status,
      assigned_writer_id: null,
      external_writer_id: externalWriterId,
      review_owner_id: editorId || null,
      notes,
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
  console.log(`CSV rows:            ${rows.length}`);
  console.log(`Writers created:     ${writersCreated}`);
  console.log(`Writers reused:      ${writersReused}`);
  console.log(`Briefs inserted:     ${inserted.length}`);
  console.log(`Briefs skipped:      ${skipped.length}`);
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
