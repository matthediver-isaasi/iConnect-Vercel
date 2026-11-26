#!/usr/bin/env node
// Regenerate retained signed sales-agreement PDFs with the current proposal
// layout. Dry-run by default. See docs/sales-agreement-pdf-reformat.md.
//
//   node scripts/reformat-signed-sales-agreements.mjs --target dest [--tenant <uuid>] [--limit N]
//   node scripts/reformat-signed-sales-agreements.mjs --target dest --apply [--tenant <uuid>] [--limit N]
//
// --target is required: `dest` (production, DEST_SUPABASE_URL/DEST_SUPABASE_KEY)
// or `runtime` (SUPABASE_URL/SUPABASE_SERVICE_KEY of this process). The signed
// snapshot, signatures and evidence hash are never modified; original files are
// never deleted or overwritten. Rerunning skips already-reformatted agreements.
import { createClient } from '@supabase/supabase-js';

const DEST_PROJECT = 'lvmzliemqnieeoruhkik';
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const target = option('--target');
const apply = args.includes('--apply');
const tenantId = option('--tenant');
const limit = option('--limit') ? Number(option('--limit')) : undefined;

if (!['dest', 'runtime'].includes(target)) {
  console.error('Specify --target dest or --target runtime.'); process.exit(2);
}
if (tenantId && !/^[0-9a-f-]{36}$/i.test(tenantId)) { console.error('--tenant must be a UUID'); process.exit(2); }
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) { console.error('--limit must be a positive integer'); process.exit(2); }

const url = target === 'dest' ? process.env.DEST_SUPABASE_URL : process.env.SUPABASE_URL;
const key = target === 'dest' ? process.env.DEST_SUPABASE_KEY : process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error(`Missing credentials for target ${target}.`); process.exit(2); }
if (target === 'dest' && new URL(url).hostname !== `${DEST_PROJECT}.supabase.co`) {
  console.error('DEST_SUPABASE_URL does not point at the pinned destination project.'); process.exit(2);
}
// Application helpers initialise a shared client from SUPABASE_URL on import;
// pin it to the selected target before importing them.
process.env.SUPABASE_URL = url; process.env.SUPABASE_SERVICE_KEY = key;
const { reformatSignedSalesAgreements } = await import('../api/_lib/salesAgreementReformat.js');

const db = createClient(url, key, { auth: { persistSession: false } });
const results = await reformatSignedSalesAgreements(db, { dryRun: !apply, tenantId, limit });
const counts = {};
for (const r of results) {
  counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(JSON.stringify({ envelope: r.id, tenant: r.tenantId, status: r.status, reason: r.reason, from: r.from, to: r.to }));
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', target, tenantId: tenantId || null, limit: limit || null, counts }));
if (counts.failed) process.exitCode = 1;
