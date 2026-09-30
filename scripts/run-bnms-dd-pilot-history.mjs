#!/usr/bin/env node
// Historical-only runner. No collection setup, promotion or provider mutation.
// Migration review: node scripts/run-bnms-dd-pilot-history.mjs --migration
// Migration apply:  add --apply --review-sha256=<printed hash>
// Data dry run: --evidence /tmp/current-evidence.json --out /tmp/new-report.json
// Data apply/resume: same flags plus --apply --review-sha256=<data dry-run hash>
import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { historicalManifest, importHistoricalPilot } from './bnms-dd-pilot-history.mjs';
import { TENANT_ID, MEMBER_ID, MANDATE_ID, CUSTOMER_ID, providerReader, readAllProviderPages } from './bnms-dd-pilot.mjs';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';

export const MIGRATION = new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql', import.meta.url);
export function parseHistoryArgs(args) {
  const opts = { apply: false, migration: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply' || a === '--migration') {
      const key = a.slice(2);
      if (opts[key]) throw new Error('Duplicate flag');
      opts[key] = true;
    } else if (/^--review-sha256=[a-f0-9]{64}$/.test(a) && !opts.reviewSha256) opts.reviewSha256 = a.split('=')[1];
    else if (['--evidence', '--out'].includes(a) && !opts[a.slice(2)] && args[i + 1] && !args[i + 1].startsWith('--')) opts[a.slice(2)] = args[++i];
    else throw new Error('Unsupported or duplicate argument; tenant/member overrides and automatic cutover are forbidden');
  }
  if (opts.migration && (opts.evidence || opts.out)) throw new Error('Migration and data modes must be separate');
  if (!opts.migration && (!opts.evidence || !opts.out || !resolve(opts.out).startsWith('/tmp/'))) throw new Error('Data mode requires --evidence and a new private --out under /tmp');
  if (opts.apply && !opts.reviewSha256) throw new Error('Apply requires exact reviewed SHA-256');
  return opts;
}
export async function destinationConnection(env = process.env) {
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt', { redirect: 'error' });
  if (!response.ok) throw new Error('Verified destination TLS CA unavailable');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination TLS CA');
  return new pg.Client({ connectionString: target.toString(),
    ssl: { ca, rejectUnauthorized: true, servername: target.hostname } });
}

// Revalidate provider settlement immediately before every dry-run/apply/resume.
// No refresh/provider write is made here. Expired auth is an explicit blocker.
export async function refreshHistoricalEvidence(evidence, db, transport = fetch) {
  const planned = historicalManifest(evidence);
  const credentials = await getTenantGocardlessCredentials(TENANT_ID, { db });
  const get = providerReader(credentials, transport);
  const mandate = (await get(`mandates/${MANDATE_ID}`)).mandates;
  if (mandate?.status !== 'active' || mandate.links?.customer !== CUSTOMER_ID
      || mandate.links?.creditor !== 'CR0000B50W1Y2R') throw new Error('Live mandate ownership/status drift');
  const payments = await readAllProviderPages(get, 'payments', { mandate: MANDATE_ID });
  const selectedPayments = payments.filter(p => planned.rows.some(r => r.provider_payment_id === p.id));
  const { data: tokens, error } = await db.from('xero_token')
    .select('tenant_id,access_token,expires_at').eq('app_tenant_id', TENANT_ID);
  if (error || tokens?.length !== 1 || tokens[0].tenant_id !== planned.xeroTenantId
      || Date.parse(tokens[0].expires_at) < Date.now() + 60_000) throw new Error('Current pinned Xero connection required; refresh authentication separately');
  const invoices = [];
  for (const row of planned.rows) {
    const response = await transport(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(row.xero_invoice_id)}`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${tokens[0].access_token}`, 'Xero-tenant-id': planned.xeroTenantId, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Xero invoice verification failed (HTTP ${response.status})`);
    const body = await response.json();
    if (body.Invoices?.length !== 1) throw new Error('Xero invoice response ambiguous');
    invoices.push(body.Invoices[0]);
  }
  const current = { ...evidence, invoices, providerPayments: selectedPayments };
  historicalManifest(current); // validates all current paid/refund/contact/nominal facts.
  return current;
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseHistoryArgs(args);
  const sql = await readFile(MIGRATION, 'utf8');
  const migrationHash = createHash('sha256').update(sql).digest('hex');
  if (opts.migration && !opts.apply) {
    console.log(JSON.stringify({ mode: 'migration_review', hash: migrationHash, writes: 0 }));
    return;
  }
  if (opts.migration && opts.reviewSha256 !== migrationHash) throw new Error('Migration review hash mismatch');
  destinationTarget(env); // checks REST and SQL pins even in data dry-run.
  let current;
  if (!opts.migration) {
    const evidence = JSON.parse(await readFile(opts.evidence, 'utf8'));
    historicalManifest(evidence); // fail identity before network access.
    if (!env.DEST_SUPABASE_KEY) throw new Error('Destination service credential required');
    const db = createClient(env.DEST_SUPABASE_URL, env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
    const { data, error } = await db.from('tenant').select('id,name').eq('id', TENANT_ID).single();
    if (error || !/\bbnms\b|british nuclear medicine society/i.test(data?.name || '')) throw new Error('Destination tenant identity mismatch');
    current = await refreshHistoricalEvidence(evidence, db);
  }
  // Reserve the audit filename before any writes, so an existing output cannot
  // cause a successful commit followed by a missing/misleading local report.
  const client = await destinationConnection(env);
  const report = opts.out ? await open(resolve(opts.out), 'wx', 0o600) : null;
  try {
    await client.connect();
    await client.query("SET statement_timeout='120s'");
    await client.query("SET lock_timeout='10s'");
    let result;
    if (opts.migration) {
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      result = { mode: 'migration_apply', hash: migrationHash, destination: 'lvmzliemqnieeoruhkik' };
    } else {
      result = await importHistoricalPilot(client, current, {
        apply: opts.apply, reviewSha256: opts.reviewSha256, verifiedDestination: true,
      });
      await report.writeFile(JSON.stringify({ ...result, memberId: MEMBER_ID, evidence: current }, null, 2));
    }
    console.log(JSON.stringify({ mode: result.mode, hash: result.hash, writes: result.writes,
      liveCollectionEnabled: false, membershipActivated: false }));
  } finally {
    await client.end();
    await report?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never serialize provider/database objects: they can contain credentials.
    console.error(`BNMS history operation failed: ${error.code || error.name}. Review private evidence and database state before retry.`);
    process.exitCode = 1;
  });
}