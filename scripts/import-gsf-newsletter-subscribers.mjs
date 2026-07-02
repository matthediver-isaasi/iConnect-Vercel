#!/usr/bin/env node
/**
 * Import historic GSF newsletter sign-ups (exported from Zoho) into the
 * `email_subscriber` table as non-member list subscriptions for the GSF
 * tenant. Mirrors what the public form-submission flow does for anonymous
 * (non-member) submitters: one email_subscriber row per communication
 * category, with `opted_out` = the inverse of the per-list tick.
 *
 * CSV (semicolon-delimited, UTF-8 BOM on first header cell):
 *   Email;Job title;All opt out;Newsletter;Jobs;Event info;First name;Last name;Free text organisation
 *
 * Column -> communication_category mapping (verified at startup):
 *   Newsletter  -> "Newsletter"        (0043b368-2f7d-4a9e-9e5a-96f18f58fb4a)
 *   Jobs        -> "Job opportunities" (b33c53c3-b322-4b53-824f-327a944a7ad2)
 *   Event info  -> "Event Updates"     (478810ca-9d68-435b-8eba-32728cb2dee7)
 * The "Community Newsletter (Snapshot)" category has no CSV column and is
 * left untouched.
 *
 * "All opt out" = true forces opted_out=true on all three categories for
 * that person regardless of the per-list values.
 *
 * "Job title" and "Free text organisation" have no destination columns on
 * email_subscriber and are NOT stored.
 *
 * Tenant-pinned by design: refuses to run for any other TENANT_ID.
 * Idempotent: compares against existing rows; re-running with the same CSV
 *   produces zero writes (subscribed_at is preserved on existing rows).
 * Dry-run by default; require --apply to write.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/import-gsf-newsletter-subscribers.mjs \
 *     [--apply] [--verbose] [--csv=<path>] [--limit=N]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;

if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[import-gsf-newsletter-subscribers] Refusing to run for tenant ${TENANT_ID}. ` +
    `This script is hard-pinned to ${ALLOWED_TENANT_ID}.`,
  );
  process.exit(1);
}

// CSV column header -> expected category id + name (verified against DB).
const CATEGORY_MAP = [
  { column: 'Newsletter', id: '0043b368-2f7d-4a9e-9e5a-96f18f58fb4a', name: 'Newsletter' },
  { column: 'Jobs', id: 'b33c53c3-b322-4b53-824f-327a944a7ad2', name: 'Job opportunities' },
  { column: 'Event info', id: '478810ca-9d68-435b-8eba-32728cb2dee7', name: 'Event Updates' },
];

const DEFAULT_CSV_PATH =
  'attached_assets/GSF_newsletter_sign_ups_from_Zoho_to_import_into_iConnect_09.0_1780932740266.csv';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const csvArg = args.find(a => a.startsWith('--csv='));
const limitArg = args.find(a => a.startsWith('--limit='));
const CSV_PATH = csvArg ? csvArg.slice('--csv='.length) : DEFAULT_CSV_PATH;
const LIMIT = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) || null : null;

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
  console.error('[import-gsf-newsletter-subscribers] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseBool(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

function loadCsv(path) {
  const abs = resolvePath(path);
  let text = readFileSync(abs, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);

  if (lines.length === 0) {
    return { byEmail: new Map(), rowCount: 0, blank: 0, skipped: [], dupes: 0, header: [] };
  }

  const header = lines[0].split(';').map(h => h.trim());
  const idx = {
    email: header.indexOf('Email'),
    allOptOut: header.indexOf('All opt out'),
    firstName: header.indexOf('First name'),
    lastName: header.indexOf('Last name'),
  };
  const colIdx = {};
  for (const c of CATEGORY_MAP) colIdx[c.column] = header.indexOf(c.column);

  // Fail fast if the export shape changed: a silently-missing category column
  // would default that list's tick to false and wrongly opt everyone out.
  const requiredHeaders = ['Email', 'All opt out', ...CATEGORY_MAP.map(c => c.column)];
  const missingHeaders = requiredHeaders.filter(h => !header.includes(h));
  if (missingHeaders.length > 0) {
    throw new Error(
      `CSV is missing required column(s): ${missingHeaders.join(', ')}. ` +
      `Found headers: ${header.join(', ')}`,
    );
  }

  const byEmail = new Map(); // emailLower -> { first_name, last_name, allOptOut, perCol }
  let rowCount = 0;
  let blank = 0;
  let dupes = 0;
  const skipped = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) { blank++; continue; }
    const parts = line.split(';');
    const emailRaw = (parts[idx.email] || '').trim();
    if (!emailRaw) {
      if (skipped.length < 10) skipped.push({ line: i + 1, reason: 'missing_email', text: line });
      continue;
    }
    const emailLower = emailRaw.toLowerCase();
    if (!EMAIL_RE.test(emailLower)) {
      if (skipped.length < 10) skipped.push({ line: i + 1, reason: 'bad_email', text: emailRaw });
      continue;
    }

    const perCol = {};
    for (const c of CATEGORY_MAP) {
      perCol[c.column] = colIdx[c.column] >= 0 ? parseBool(parts[colIdx[c.column]]) : false;
    }
    const record = {
      first_name: idx.firstName >= 0 ? (parts[idx.firstName] || '').trim() || null : null,
      last_name: idx.lastName >= 0 ? (parts[idx.lastName] || '').trim() || null : null,
      allOptOut: idx.allOptOut >= 0 ? parseBool(parts[idx.allOptOut]) : false,
      perCol,
    };

    if (byEmail.has(emailLower)) dupes++; // last-write-wins
    byEmail.set(emailLower, record);
    rowCount++;
  }

  return { byEmail, rowCount, blank, dupes, skipped, header };
}

async function verifyCategories() {
  const ids = CATEGORY_MAP.map(c => c.id);
  const { data, error } = await supabase
    .from('communication_category')
    .select('id, name, tenant_id, is_active')
    .in('id', ids);
  if (error) throw new Error(`communication_category lookup failed: ${error.message}`);
  const byId = new Map((data || []).map(c => [c.id, c]));
  for (const c of CATEGORY_MAP) {
    const found = byId.get(c.id);
    if (!found) throw new Error(`category ${c.id} (${c.name}) not found`);
    if (found.tenant_id !== TENANT_ID) {
      throw new Error(`category ${c.id} belongs to tenant ${found.tenant_id}, expected ${TENANT_ID}`);
    }
    if (found.name !== c.name) {
      throw new Error(`category ${c.id} name is '${found.name}', expected '${c.name}'`);
    }
    if (!found.is_active) {
      console.warn(`  WARNING: category ${c.id} (${c.name}) is not active`);
    }
  }
}

async function fetchExistingSubscribers(emails) {
  // (emailLower + '|' + categoryId) -> { id, opted_out }
  const out = new Map();
  for (let i = 0; i < emails.length; i += 200) {
    const batch = emails.slice(i, i + 200);
    const { data, error } = await supabase
      .from('email_subscriber')
      .select('id, email, communication_category_id, opted_out')
      .eq('tenant_id', TENANT_ID)
      .in('communication_category_id', CATEGORY_MAP.map(c => c.id))
      .in('email', batch);
    if (error) throw new Error(`email_subscriber fetch failed: ${error.message}`);
    for (const r of (data || [])) {
      out.set(`${(r.email || '').toLowerCase()}|${r.communication_category_id}`, {
        id: r.id,
        opted_out: r.opted_out,
      });
    }
  }
  return out;
}

async function main() {
  console.log(APPLY ? '=== LIVE RUN ===' : '=== DRY RUN ===');
  console.log('Tenant :', TENANT_ID);
  console.log('CSV    :', CSV_PATH);
  if (LIMIT) console.log('Limit  :', LIMIT);
  console.log('');

  await verifyCategories();
  console.log('Verified all 3 target categories belong to tenant and names match.\n');

  const { byEmail, rowCount, blank, dupes, skipped } = loadCsv(CSV_PATH);
  console.log('=== CSV parse ===');
  console.log(`Data rows kept : ${rowCount}`);
  console.log(`Unique emails  : ${byEmail.size}`);
  console.log(`Blank lines    : ${blank}`);
  console.log(`Duplicate email rows (last-write-wins): ${dupes}`);
  console.log(`Skipped        : ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) console.log(`  line ${s.line} [${s.reason}]: ${s.text}`);
  }
  console.log('NOTE: "Job title" and "Free text organisation" columns are not stored (no destination columns).\n');

  let emails = Array.from(byEmail.keys());
  if (LIMIT) emails = emails.slice(0, LIMIT);

  if (emails.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const existing = await fetchExistingSubscribers(emails);

  const nowIso = new Date().toISOString();
  const inserts = [];
  const updates = [];
  let unchanged = 0;
  let subscribedRows = 0;
  let optedOutRows = 0;
  const diffsToPrint = [];

  for (const email of emails) {
    const rec = byEmail.get(email);
    for (const c of CATEGORY_MAP) {
      const optedOut = rec.allOptOut ? true : !rec.perCol[c.column];
      if (optedOut) optedOutRows++; else subscribedRows++;
      const key = `${email}|${c.id}`;
      const ex = existing.get(key);
      if (!ex) {
        inserts.push({
          tenant_id: TENANT_ID,
          email,
          first_name: rec.first_name,
          last_name: rec.last_name,
          form_id: null,
          communication_category_id: c.id,
          opted_out: optedOut,
          subscribed_at: nowIso,
          opted_out_at: optedOut ? nowIso : null,
          updated_at: nowIso,
        });
        if (diffsToPrint.length < 10) diffsToPrint.push({ email, cat: c.name, action: 'insert', opted_out: optedOut });
      } else if (ex.opted_out !== optedOut) {
        updates.push({ id: ex.id, opted_out: optedOut, opted_out_at: optedOut ? nowIso : null });
        if (diffsToPrint.length < 10) diffsToPrint.push({ email, cat: c.name, action: 'update', from: ex.opted_out, to: optedOut });
      } else {
        unchanged++;
      }
    }
  }

  console.log('=== Plan ===');
  console.log(`Target people            : ${emails.length}`);
  console.log(`Target rows (people x 3) : ${emails.length * CATEGORY_MAP.length}`);
  console.log(`  - subscribed (opted_out=false): ${subscribedRows}`);
  console.log(`  - opted out  (opted_out=true) : ${optedOutRows}`);
  console.log(`Insert (new rows)        : ${inserts.length}`);
  console.log(`Update (opt-out changed) : ${updates.length}`);
  console.log(`Unchanged                : ${unchanged}`);

  if (diffsToPrint.length > 0) {
    console.log('\n=== First diffs (preview) ===');
    for (const d of diffsToPrint) {
      if (d.action === 'insert') console.log(`  [insert] ${d.email} / ${d.cat} -> opted_out=${d.opted_out}`);
      else console.log(`  [update] ${d.email} / ${d.cat} -> opted_out ${d.from} => ${d.to}`);
    }
  }
  if (VERBOSE) {
    console.log('\nAll inserts:');
    for (const r of inserts) console.log(`  insert ${r.email} / ${r.communication_category_id} opted_out=${r.opted_out}`);
    console.log('All updates:');
    for (const u of updates) console.log(`  update id=${u.id} opted_out=${u.opted_out}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    return;
  }

  if (inserts.length === 0 && updates.length === 0) {
    console.log('\nNothing to write.');
    return;
  }

  let written = 0;
  let errors = 0;

  // Inserts via upsert on the (tenant_id, email, communication_category_id)
  // unique key — safe even if a row appeared since we read existing rows.
  for (let i = 0; i < inserts.length; i += 200) {
    const batch = inserts.slice(i, i + 200);
    const { error } = await supabase
      .from('email_subscriber')
      .upsert(batch, { onConflict: 'tenant_id,email,communication_category_id' });
    if (error) {
      console.error(`Insert batch failed (${batch.length} rows):`, error.message);
      errors += batch.length;
    } else {
      written += batch.length;
    }
  }

  // Updates by id — only the opt-out fields, preserving subscribed_at.
  for (const u of updates) {
    const { error } = await supabase
      .from('email_subscriber')
      .update({ opted_out: u.opted_out, opted_out_at: u.opted_out_at, updated_at: nowIso })
      .eq('id', u.id);
    if (error) {
      console.error(`Update id=${u.id} failed:`, error.message);
      errors += 1;
    } else {
      written += 1;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Inserts attempted : ${inserts.length}`);
  console.log(`Updates attempted : ${updates.length}`);
  console.log(`Rows written      : ${written}`);
  console.log(`Errors            : ${errors}`);
  console.log(`Unchanged         : ${unchanged}`);
  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('[import-gsf-newsletter-subscribers] Failed:', err.message || err);
  process.exit(1);
});
