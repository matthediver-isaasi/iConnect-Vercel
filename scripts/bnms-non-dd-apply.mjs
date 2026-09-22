#!/usr/bin/env node
// Reviewed, fixed-cycle BNMS history import. Dry-run unless --apply is present.
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventory, classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
import { TENANT } from './audit-bnms-non-dd-pilot.mjs';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { revalidateInvoices } from './revalidate-bnms-non-dd-invoices.mjs';

const TOP = ['version', 'tenantId', 'asOf', 'sourceHash', 'rows', 'evidence'];
const ROW = ['id', 'member_id', 'tenant_id', 'membership_year', 'term_end_date',
  'term_start_date', 'status', 'payment_status', 'config_id', 'tier_label',
  'final_cost', 'total_with_vat', 'currency', 'payment_method', 'billing_period',
  'accounting_provider', 'accounting_invoice_id', 'accounting_invoice_number',
  'xero_invoice_id', 'xero_invoice_number', 'notes'];
const EVIDENCE = ['memberId', 'sourceHash'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const reject = message => { throw new Error(message); };

function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
}
export const canonicalHash = value =>
  createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export function deterministicId(memberId) {
  const h = createHash('sha256').update(JSON.stringify(`bnms-non-dd-current:2025/2026:${memberId}`)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== [...keys].sort().join()) reject(`${label} has missing or extraneous fields`);
}
function nullableString(value, label) {
  if (value !== null && (typeof value !== 'string' || !value)) reject(`${label} must be null or non-empty text`);
}

export function validateManifest(manifest) {
  exactKeys(manifest, TOP, 'Manifest');
  if (manifest.version !== 1 || manifest.tenantId !== TENANT || manifest.asOf !== '2026-09-22'
      || !HASH.test(manifest.sourceHash) || !Array.isArray(manifest.rows)
      || !manifest.rows.length || !Array.isArray(manifest.evidence)) reject('Manifest pins are invalid');
  const ids = new Set(), members = new Set(), invoices = new Set(), invoiceNumbers = new Set();
  for (const row of manifest.rows) {
    exactKeys(row, ROW, 'Row');
    if (!UUID.test(row.id) || !UUID.test(row.member_id) || row.id !== deterministicId(row.member_id)
        || row.tenant_id !== TENANT || row.membership_year !== '2025/2026'
        || row.term_start_date !== null || row.status !== 'active' || row.payment_status !== 'paid'
        || row.config_id !== null || typeof row.tier_label !== 'string' || !row.tier_label
        || (row.final_cost !== null && (!Number.isFinite(row.final_cost) || row.final_cost < 0))
        || row.total_with_vat !== row.final_cost || row.currency !== 'GBP'
        || row.payment_method !== 'upfront' || row.billing_period !== 'annual'
        || !['xero', null].includes(row.accounting_provider)
        || !/^\d{4}-\d{2}-\d{2}$/.test(row.term_end_date)
        || new Date(`${row.term_end_date}T00:00:00Z`).toISOString().slice(0, 10) !== row.term_end_date
        || row.term_end_date < manifest.asOf || row.term_end_date > '2026-12-31') reject('Row violates approved fixed-cycle values');
    for (const key of ['accounting_invoice_id', 'accounting_invoice_number', 'xero_invoice_id', 'xero_invoice_number']) nullableString(row[key], key);
    if (row.accounting_provider === 'xero') {
      if (!row.accounting_invoice_id || !row.accounting_invoice_number
          || row.accounting_invoice_id !== row.xero_invoice_id
          || row.accounting_invoice_number !== row.xero_invoice_number) reject('Xero identities must be complete and equal');
    } else if ([row.accounting_invoice_id, row.accounting_invoice_number,
      row.xero_invoice_id, row.xero_invoice_number].some(v => v !== null)) reject('Invoice identity requires Xero provider');
    let notes;
    try { notes = JSON.parse(row.notes); } catch { reject('notes must be JSON text'); }
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)
        || notes.source !== 'bnms_non_dd_current_backfill' || notes.version !== 1
        || !HASH.test(notes.sourceHash) || notes.startDateAuthority !== 'unknown_not_inferred'
        || notes.expiryAuthority !== 'retained_legacy_expiry') reject('notes provenance mismatch');
    if (row.accounting_provider === null && (row.final_cost !== null
        || notes.paymentAuthority !== 'operator_attested_upfront_paid_2025_2026'
        || notes.termAuthority !== 'operator_attested_existing_2025_2026'
        || notes.invoiceAuthority !== 'unresolved_not_linked'
        || notes.historicalAmountAuthority !== 'unknown_not_inferred'
        || !['invoice_term_unconfirmed', 'missing_or_ambiguous_contact', 'invoice_period_conflict',
          'equal_date_or_missing_date_ambiguity', 'missing_paid_membership_invoice',
          'financial_or_mixed_invoice_conflict', 'payment_detail_conflict'].includes(notes.invoiceReviewState))) {
      reject('Unlinked membership needs explicit operator attestation and unknown historical amount');
    }
    if (ids.has(row.id) || members.has(row.member_id)) reject('Duplicate row/member identity');
    ids.add(row.id); members.add(row.member_id);
    if (row.xero_invoice_id && invoices.has(row.xero_invoice_id)) reject('Duplicate invoice identity');
    if (row.xero_invoice_number && invoiceNumbers.has(row.xero_invoice_number)) reject('Duplicate invoice identity');
    if (row.xero_invoice_id) invoices.add(row.xero_invoice_id);
    if (row.xero_invoice_number) invoiceNumbers.add(row.xero_invoice_number);
  }
  if (manifest.evidence.length !== manifest.rows.length) reject('Evidence must cover every row exactly once');
  const evidenceMembers = new Set();
  for (const item of manifest.evidence) {
    exactKeys(item, EVIDENCE, 'Evidence');
    if (!members.has(item.memberId) || !HASH.test(item.sourceHash)
        || evidenceMembers.has(item.memberId)) reject('Evidence identity/hash mismatch');
    evidenceMembers.add(item.memberId);
    const row = manifest.rows.find(candidate => candidate.member_id === item.memberId);
    if (JSON.parse(row.notes).sourceHash !== item.sourceHash) reject('Evidence provenance hash mismatch');
  }
  return manifest;
}

const SOURCE_SQL = `WITH prefs AS (
 SELECT v.member_id,jsonb_object_agg(f.name,v.value) preferences,count(*)<>count(DISTINCT f.name) duplicate_fields
 FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
 WHERE f.tenant_id=$1 AND f.name IN ('ym_web_site_member_id','membership_status','ym_date_membership_expires','ym_membership_type','member_class','direct_debit_payment') GROUP BY v.member_id
), dd AS (
 SELECT member_id FROM bnms_dd_alpha_adoption WHERE tenant_id=$1 UNION SELECT member_id FROM bnms_dd_beta_adoption WHERE tenant_id=$1
 UNION SELECT member_id FROM bnms_dd_pilot_import WHERE tenant_id=$1 UNION SELECT member_id FROM bnms_dd_historical_payment WHERE tenant_id=$1
 UNION SELECT m.id FROM member m JOIN membership_billing_agreements a ON a.tenant_id=m.tenant_id AND (a.member_id=m.id OR a.primary_contact_member_id=m.id OR a.organization_id=m.organization_id) WHERE m.tenant_id=$1 AND (a.provider='gocardless' OR a.gocardless_mandate_id IS NOT NULL OR a.gocardless_customer_id IS NOT NULL OR a.metadata ? 'dd')
 UNION SELECT m.id FROM member m JOIN membership_payment_plans p ON p.tenant_id=m.tenant_id AND (p.member_id=m.id OR p.organization_id=m.organization_id) WHERE m.tenant_id=$1 AND (p.provider='gocardless' OR p.gocardless_mandate_id IS NOT NULL OR p.gocardless_subscription_id IS NOT NULL)
 UNION SELECT m.id FROM member m JOIN gocardless_customers c ON c.tenant_id=m.tenant_id AND (c.member_id=m.id OR c.organization_id=m.organization_id OR lower(trim(c.email))=lower(trim(m.email))) WHERE m.tenant_id=$1
 UNION SELECT m.id FROM member m JOIN gocardless_mandate_discovery_row d ON d.tenant_id=m.tenant_id AND (d.matched_member_id=m.id OR d.normalized_email=lower(trim(m.email))) WHERE m.tenant_id=$1
 UNION SELECT member_id FROM member_membership_history WHERE tenant_id=$1 AND payment_method IN ('direct_debit','gocardless')
 ) SELECT m.id,md5(lower(trim(m.email))) email_hash,coalesce(p.preferences,'{}') preferences,coalesce(p.duplicate_fields,false) duplicate_fields,
 EXISTS(SELECT 1 FROM dd WHERE dd.member_id=m.id) dd_evidence,
 (SELECT count(*)::int FROM member_membership_history h WHERE h.tenant_id=$1 AND h.member_id=m.id) history_count
 FROM member m LEFT JOIN prefs p ON p.member_id=m.id WHERE m.tenant_id=$1 ORDER BY m.id`;

async function currentSource(client, ownMembers = new Set()) {
  const rows = (await client.query(SOURCE_SQL, [TENANT])).rows.map(row => ({
    ...row, history_count: Number(row.history_count) - (ownMembers.has(row.id) ? 1 : 0),
    category: null, expiry: legacyExpiry(row.preferences.ym_date_membership_expires),
  }));
  for (const row of rows) row.category = classify(row);
  return { rows, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}
const same = (a, b) => canonicalHash(a) === canonicalHash(b);
function rowValues(row) {
  return ROW.map(key => row[key]);
}
function ownProjection(row) {
  return Object.fromEntries(ROW.map(key => [key,
    ['final_cost', 'total_with_vat'].includes(key) && row[key] !== null ? Number(row[key])
      : ['term_start_date', 'term_end_date'].includes(key) && row[key] instanceof Date
        ? row[key].toISOString().slice(0, 10) : row[key]]));
}

export async function applyManifest(client, input, { apply = false, reviewSha256,
  verifiedDestination = false, journal } = {}) {
  const manifest = validateManifest(input);
  const hash = canonicalHash(manifest);
  if (apply && (!verifiedDestination || reviewSha256 !== hash)) reject('Apply requires pinned destination and exact reviewed manifest hash');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-non-dd-apply-v1'))");
    await client.query(`LOCK TABLE member,member_preference_value,preference_field,member_membership_history,
      organisation_membership_history,membership_billing_agreements,membership_payment_plans,gocardless_customers,
      gocardless_mandate_discovery_row,gocardless_payments,bnms_dd_alpha_adoption,bnms_dd_beta_adoption,
      bnms_dd_pilot_import,bnms_dd_historical_payment,bnms_dd_alpha_invoice_link,
      bnms_dd_beta_invoice_link IN SHARE ROW EXCLUSIVE MODE`);
    const tenant = await client.query('SELECT id,slug FROM tenant WHERE id=$1', [TENANT]);
    if (tenant.rows.length !== 1 || tenant.rows[0].slug !== 'bnms') reject('Pinned BNMS destination mismatch');
    const existing = await client.query('SELECT * FROM member_membership_history WHERE tenant_id=$1 AND member_id=ANY($2::uuid[]) FOR UPDATE',
      [TENANT, manifest.rows.map(r => r.member_id)]);
    const own = new Set();
    for (const dbRow of existing.rows) {
      const wanted = manifest.rows.find(r => r.member_id === dbRow.member_id);
      if (!wanted || !same(ownProjection(dbRow), wanted)) reject('Existing history row is not the exact imported row');
      own.add(dbRow.member_id);
    }
    const source = await currentSource(client, own);
    if (source.hash !== manifest.sourceHash) reject('Fresh inventory sourceHash mismatch');
    for (const row of manifest.rows) {
      const candidate = source.rows.find(item => item.id === row.member_id);
      const evidence = manifest.evidence.find(item => item.memberId === row.member_id);
      if (!candidate || candidate.category !== 'requires_term_and_invoice_review'
          || candidate.expiry !== row.term_end_date
          || createHash('sha256').update(JSON.stringify(candidate)).digest('hex') !== evidence.sourceHash) {
        reject('Current member expiry/cohort evidence drift');
      }
    }
    const memberRows = await client.query('SELECT id FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
      [TENANT, manifest.rows.map(r => r.member_id)]);
    if (memberRows.rows.length !== manifest.rows.length) reject('Manifest member missing from pinned tenant');
    const invoiceIds = manifest.rows.map(r => r.xero_invoice_id).filter(Boolean);
    if (invoiceIds.length) {
      const collision = await client.query(`SELECT id FROM member_membership_history WHERE tenant_id=$1 AND member_id<>ALL($2::uuid[]) AND (xero_invoice_id::text=ANY($3::text[]) OR accounting_invoice_id::text=ANY($3::text[]))
        UNION ALL SELECT id FROM organisation_membership_history WHERE tenant_id=$1 AND (xero_invoice_id::text=ANY($3::text[]) OR accounting_invoice_id::text=ANY($3::text[]))
        UNION ALL SELECT id FROM gocardless_payments WHERE tenant_id=$1 AND (xero_invoice_id::text=ANY($3::text[]) OR accounting_invoice_id::text=ANY($3::text[]))
        UNION ALL SELECT id FROM bnms_dd_historical_payment WHERE tenant_id=$1 AND xero_invoice_id::text=ANY($3::text[])
        UNION ALL SELECT history_id FROM bnms_dd_alpha_invoice_link WHERE tenant_id=$1 AND xero_invoice_id::text=ANY($3::text[])
        UNION ALL SELECT history_id FROM bnms_dd_beta_invoice_link WHERE tenant_id=$1 AND xero_invoice_id::text=ANY($3::text[])`,
      [TENANT, manifest.rows.map(r => r.member_id), invoiceIds]);
      if (collision.rows.length) reject('Invoice identity already linked elsewhere');
    }
    if (own.size) {
      if (own.size !== manifest.rows.length) reject('Partial replay is forbidden');
      await client.query('ROLLBACK');
      return { mode: 'replay', hash, writes: 0, insertedIds: [], beforeCount: existing.rows.length,
        afterCount: existing.rows.length, insertedRows: [] };
    }
    if (!apply) {
      await client.query('ROLLBACK');
      return { mode: 'dry_run', hash, writes: 0, insertedIds: [], beforeCount: 0,
        afterCount: manifest.rows.length, manifest };
    }
    const insertedRows = [];
    for (const row of manifest.rows) {
      const result = await client.query(`INSERT INTO member_membership_history (${ROW.join(',')})
        VALUES (${ROW.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, rowValues(row));
      if (result.rows.length !== 1 || !same(ownProjection(result.rows[0]), row)) {
        reject('Inserted row projection differs from reviewed manifest');
      }
      insertedRows.push(result.rows[0]);
    }
    const result = { mode: 'apply', hash, writes: insertedRows.length,
      insertedIds: insertedRows.map(r => r.id), beforeCount: 0,
      afterCount: insertedRows.length, insertedRows };
    if (typeof journal !== 'function') reject('Durable pre-commit journal callback required');
    await journal({ ...result, committed: false });
    await client.query('COMMIT');
    return { ...result, committed: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function rollback(client, manifestInput, report, { reviewSha256, verifiedDestination = false } = {}) {
  const manifest = validateManifest(manifestInput), hash = canonicalHash(manifest);
  if (!verifiedDestination || reviewSha256 !== hash || report?.mode !== 'apply'
      || report.hash !== hash || !Array.isArray(report.insertedRows)
      || report.insertedRows.length !== manifest.rows.length) reject('Rollback requires saved apply rows and exact manifest hash');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-non-dd-apply-v1'))");
    await client.query(`LOCK TABLE member_membership_history,bnms_dd_alpha_adoption,
      bnms_dd_beta_adoption,bnms_dd_pilot_adoption,bnms_dd_alpha_membership_recognition
      IN SHARE ROW EXCLUSIVE MODE`);
    const tenant = await client.query('SELECT id,slug FROM tenant WHERE id=$1', [TENANT]);
    if (tenant.rows.length !== 1 || tenant.rows[0].slug !== 'bnms') reject('Pinned BNMS destination mismatch');
    const reportIds = report.insertedRows.map(row => row.id);
    if (new Set(reportIds).size !== manifest.rows.length
        || manifest.rows.some(row => {
          const saved = report.insertedRows.find(item => item.id === row.id);
          return !saved || !same(ownProjection(saved), row);
        })) reject('Saved rollback rows do not match manifest identities/payload');
    const current = await client.query('SELECT * FROM member_membership_history WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [TENANT, reportIds]);
    const saved = [...report.insertedRows].sort((a, b) => a.id.localeCompare(b.id));
    if (!same(current.rows, saved)) reject('Imported rows changed; rollback refused');
    const downstream = await client.query(`SELECT history_id FROM bnms_dd_alpha_adoption WHERE history_id=ANY($1::uuid[])
      UNION ALL SELECT history_id FROM bnms_dd_beta_adoption WHERE history_id=ANY($1::uuid[])
      UNION ALL SELECT history_id FROM bnms_dd_pilot_adoption WHERE history_id=ANY($1::uuid[])
      UNION ALL SELECT history_id FROM bnms_dd_alpha_membership_recognition WHERE history_id=ANY($1::uuid[])`, [reportIds]);
    if (downstream.rows.length) reject('Downstream references exist; rollback refused');
    const deleted = await client.query('DELETE FROM member_membership_history WHERE tenant_id=$1 AND id=ANY($2::uuid[]) RETURNING id',
      [TENANT, saved.map(r => r.id)]);
    if (deleted.rows.length !== saved.length) reject('Rollback delete count mismatch');
    await client.query('COMMIT');
    return { mode: 'rollback', hash, writes: deleted.rows.length, deletedIds: deleted.rows.map(r => r.id),
      beforeCount: saved.length, afterCount: 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function parseArgs(args) {
  const opts = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply' && !opts.apply) opts.apply = true;
    else if (['--manifest', '--out', '--rollback'].includes(a) && !opts[a.slice(2)]
      && args[i + 1] && !args[i + 1].startsWith('--')) opts[a.slice(2)] = args[++i];
    else if (/^--review-sha256=[a-f0-9]{64}$/.test(a) && !opts.reviewSha256) opts.reviewSha256 = a.split('=')[1];
    else reject('Unsupported or duplicate argument');
  }
  if (!opts.manifest || !opts.out || !resolve(opts.out).startsWith('/tmp/')) reject('A manifest and new private --out under /tmp are required');
  if (opts.rollback && opts.apply) reject('Rollback and apply modes are separate');
  if ((opts.apply || opts.rollback) && !opts.reviewSha256) reject('Write mode requires reviewed SHA-256');
  return opts;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(args);
  const input = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const manifest = validateManifest(input.manifest || input);
  // Imported canonical inventory is also refreshed immediately before opening
  // the write transaction; the in-transaction equivalent is authoritative.
  await inventory();
  const output = await open(resolve(opts.out), 'wx', 0o600);
  const client = await destinationConnection(env);
  try {
    await client.connect();
    if (opts.apply) {
      // Exact replay is verified below and performs no writes. Every new
      // application rechecks the live provider before acquiring DB locks.
      const prior = await client.query('SELECT id FROM member_membership_history WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [TENANT, manifest.rows.map(row => row.id)]);
      if (prior.rows.length !== manifest.rows.length) await revalidateInvoices(manifest);
    }
    const writeJournal = async value => {
      const data = Buffer.from(JSON.stringify(value, null, 2));
      await output.truncate(0);
      await output.write(data, 0, data.length, 0);
      await output.sync();
    };
    const result = opts.rollback
      ? await rollback(client, manifest, JSON.parse(await readFile(opts.rollback, 'utf8')),
        { reviewSha256: opts.reviewSha256, verifiedDestination: true })
      : await applyManifest(client, manifest,
        { apply: opts.apply, reviewSha256: opts.reviewSha256, verifiedDestination: true,
          journal: writeJournal });
    await writeJournal(result);
    console.log(JSON.stringify({ mode: result.mode, hash: result.hash, writes: result.writes,
      beforeCount: result.beforeCount, afterCount: result.afterCount }));
  } finally {
    await client.end();
    await output.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`BNMS non-DD operation failed: ${error.message}`); process.exitCode = 1; });
}