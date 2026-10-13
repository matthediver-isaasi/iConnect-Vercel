// Explicitly approved 72-member cohort only. No provider or application services.
// prepare -> dry-run (real inserts rolled back) -> apply -> replay.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inventory, classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
import { SOURCE_SQL } from './bnms-non-dd-apply.mjs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { UNEXPIRED_SOURCE, isBnmsUnexpiredAttestation } from '../api/_lib/bnmsUnexpiredAttestation.js';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const file = '/tmp/bnms-approved-unexpired-72.json';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const eligible = r => r.category === 'requires_term_and_invoice_review'
  && ['Full with NMC', 'Full junior with NMC'].includes(r.preferences.member_class)
  && r.expiry > '2026-12-31';
const mode = process.argv[2];
if (!['prepare', 'dry-run', 'apply'].includes(mode)) throw Error('Expected prepare, dry-run or apply');
if (mode === 'prepare') {
  const snapshot = await inventory();
  const source = snapshot.candidates.filter(eligible);
  if (source.length !== 72) throw Error('Approved cohort count changed');
  await writeFile(file, JSON.stringify({ source, hash: hash(source) }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ prepared: 72, hash: hash(source), writes: 0 }));
} else {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.source.length !== 72 || hash(manifest.source) !== manifest.hash
    || manifest.source.some(r => !eligible(r))) throw Error('Invalid pinned manifest');
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query(`LOCK TABLE member,member_preference_value,preference_field,member_membership_history,
      membership_billing_agreements,membership_payment_plans,gocardless_customers,
      gocardless_mandate_discovery_row,bnms_dd_alpha_adoption,bnms_dd_beta_adoption,
      bnms_dd_pilot_import,bnms_dd_historical_payment IN SHARE ROW EXCLUSIVE MODE`);
    const original = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE tenant_id=$1 ORDER BY id', [tenant])).rows;
    const source = (await db.query(SOURCE_SQL, [tenant])).rows;
    let inserted = 0, replayed = 0;
    for (const pinned of manifest.source) {
      const live = source.find(r => r.id === pinned.id);
      const digest = hash(`${UNEXPIRED_SOURCE}:${pinned.id}`);
      const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const existing = original.find(r => r.data.id === id)?.data;
      const normalized = { ...live, history_count: live.history_count - (existing ? 1 : 0) };
      normalized.category = classify(normalized);
      normalized.expiry = legacyExpiry(normalized.preferences.ym_date_membership_expires);
      if (hash(normalized) !== hash(pinned)) throw Error('Member source changed since approval');
      const notes = {
        source: UNEXPIRED_SOURCE, version: 1, memberId: pinned.id, expiry: pinned.expiry,
        sourceHash: hash(pinned), approvalDate: '2026-10-13',
        paymentAuthority: 'operator_confirmed_paid', startDateAuthority: 'unknown_not_inferred',
        expiryAuthority: 'retained_legacy_expiry', invoiceAuthority: 'not_verified_not_linked',
        historicalAmountAuthority: 'unknown_not_inferred',
      };
      if (existing) {
        if (!isBnmsUnexpiredAttestation(existing) || existing.notes !== JSON.stringify(notes))
          throw Error('Replay does not match approved record');
        replayed++; continue;
      }
      const result = await db.query(`INSERT INTO member_membership_history
        (id,tenant_id,member_id,membership_year,tier_label,term_start_date,term_end_date,
         status,payment_status,payment_method,billing_period,currency,notes)
        VALUES ($1,$2,$3,'Legacy membership (start unknown)',$4,NULL,$5,
          'active','paid','upfront','annual','GBP',$6)
        RETURNING to_jsonb(member_membership_history) data`,
      [id, tenant, pinned.id, pinned.preferences.ym_membership_type, pinned.expiry, JSON.stringify(notes)]);
      if (!isBnmsUnexpiredAttestation(result.rows[0].data)) throw Error('Inserted record verification failed');
      inserted++;
    }
    const after = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE tenant_id=$1 ORDER BY id', [tenant])).rows;
    const oldIds = new Set(original.map(r => r.data.id));
    if (hash(after.filter(r => oldIds.has(r.data.id))) !== hash(original)
      || after.length !== original.length + inserted) throw Error('Existing history changed');
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode, inserted: mode === 'apply' ? inserted : 0, validatedInserts: inserted,
      replayed, existingHistoryUnchanged: true, cohortHash: manifest.hash }));
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
}
