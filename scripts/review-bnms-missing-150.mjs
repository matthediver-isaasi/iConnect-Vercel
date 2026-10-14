#!/usr/bin/env node
// Read-only evidence capture. No apply mode, provider access, or write SQL.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
import { SOURCE_SQL } from './bnms-non-dd-apply.mjs';
import { classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';

if (process.argv.length !== 2) throw Error('This review accepts no arguments and has no apply mode');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const auditPath = 'generated-artifacts/bnms-missing-history-review/receipt-1791962083646.json';
const out = 'generated-artifacts/bnms-missing-150-review';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const auditBytes = await readFile(auditPath);
const audit = JSON.parse(auditBytes);
const cohort = audit.missing.filter(r => r.memberClass !== 'Former' && r.legacyStatus === 'Active'
  && r.expiryGroup === 'Unexpired' && r.ddEvidence === false
  && r.seedingClassification === 'requires_term_and_invoice_review' && r.originallyInWindow === false);
if (cohort.length !== 150 || new Set(cohort.map(r => r.memberId)).size !== 150
  || cohort.some(r => r.expiry <= '2026-12-31')) throw Error('Pinned audit cohort mismatch');
const ids = cohort.map(r => r.memberId);
const db = await connectDestination();
let snapshot;
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='120s'");
  const identity = (await db.query('SELECT id,slug FROM tenant WHERE id=$1', [tenant])).rows;
  if (identity.length !== 1 || identity[0].slug !== 'bnms') throw Error('Tenant mismatch');
  const source = (await db.query(SOURCE_SQL, [tenant])).rows.filter(r => ids.includes(r.id))
    .map(r => ({ ...r, category: classify(r), expiry: legacyExpiry(r.preferences.ym_date_membership_expires) }));
  if (source.length !== 150) throw Error('Member missing from live tenant');
  const members = (await db.query(`SELECT id,email,first_name,last_name,status,is_guest,is_sample
    FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [tenant, ids])).rows;
  const invoices = (await db.query(`SELECT i.*,b.source_sha256,b.worksheet
    FROM historical_member_invoice i LEFT JOIN historical_invoice_import b ON b.id=i.import_id AND b.tenant_id=i.tenant_id
    WHERE i.tenant_id=$1 AND i.member_id=ANY($2::uuid[]) ORDER BY i.member_id,i.id`, [tenant, ids])).rows;
  const histories = (await db.query(`SELECT * FROM member_membership_history
    WHERE tenant_id=$1 AND member_id=ANY($2::uuid[]) ORDER BY id`, [tenant, ids])).rows;
  snapshot = { version: 1, capturedAt: new Date().toISOString(), asOf: '2026-10-14',
    tenant, auditPath, auditSha256: sha(auditBytes), cohort, source, members, invoices, histories,
    authority: 'Review only; no cohort paid attestation; no provider verification performed',
    writes: 0, approved: false };
} finally {
  await db.query('ROLLBACK');
  await db.end();
}
await mkdir(out, { recursive: true, mode: 0o700 });
const bytes = JSON.stringify(snapshot, null, 2) + '\n';
await writeFile(`${out}/snapshot.json`, bytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ members: cohort.length, localHistoricalInvoices: snapshot.invoices.length,
  liveHistories: snapshot.histories.length, snapshotSha256: sha(bytes), writes: 0 }));
