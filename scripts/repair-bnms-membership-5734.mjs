// Explicitly approved paid-term reconstruction; no UPDATE/DELETE or provider financial writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { buildPlan, assertRecord, MEMBER, TENANT, ORIGINAL, TARGET, INVOICE, RELATED } from './lib/bnms-membership-5734-plan.mjs';

const mode = process.argv[2];
assert.ok(['dry-run', 'apply', 'verify'].includes(mode), 'Use dry-run, apply or verify');
// Refreshes provider invoice/contact/payment/PDF evidence before every operation.
const { evidence } = await import('./inspect-bnms-membership-5734.mjs');
const { record, original } = buildPlan(evidence);
const dir = 'generated-artifacts/bnms-membership-5734';
const manifestPath = `${dir}/approved-dry-run.json`;
const db = await connectDestination();
let committed = false;
try {
  await db.query(mode === 'verify' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  // Serialize against all history writers, including legacy paths without owner locking.
  if (mode !== 'verify') {
    await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
    await db.query('SELECT id FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [MEMBER, TENANT]);
  }
  const rows = async table => (await db.query(`SELECT to_jsonb(r) data FROM ${table} r
    WHERE member_id=$1 AND tenant_id=$2 ORDER BY id`, [MEMBER, TENANT])).rows.map(r => r.data);
  const owner = async () => (await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2', [MEMBER, TENANT])).rows[0]?.data;
  const prefsSql = `SELECT v.id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
    WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`;
  const prefs = async () => (await db.query(prefsSql, [MEMBER, TENANT])).rows;
  const configs = async () => (await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c
    JOIN preference_field f ON f.id=c.structure_field_id WHERE c.tenant_id=$1 AND f.tenant_id=$1
    AND f.name='member_class' AND c.structure_match_value='Overseas Full' ORDER BY c.id`, [TENANT])).rows.map(r => r.data);
  const unchanged = async () => {
    assert.deepEqual(await owner(), evidence.owner, 'Member changed');
    assert.deepEqual(await prefs(), evidence.preferences, 'Preferences changed');
    assert.deepEqual(await configs(), evidence.configs, 'Mapping changed');
    for (const table of RELATED) assert.deepEqual(await rows(table), evidence[table], `${table} changed`);
  };
  await unchanged();
  const before = await rows('member_membership_history');
  assert.deepEqual(before, evidence.member_membership_history, 'History changed during provider refresh');
  assert.deepEqual(before.find(h => h.id === ORIGINAL), original);
  const linked = (await db.query(`SELECT id FROM member_membership_history
    WHERE accounting_invoice_id=$1 OR xero_invoice_id=$1`, [INVOICE])).rows;
  assert.ok(linked.every(h => h.id === TARGET), 'Invoice is already allocated to another history');
  const manifest = { owner: evidence.owner, preferences: evidence.preferences, configs: evidence.configs,
    original, related: Object.fromEntries(RELATED.map(t => [t, evidence[t]])), record };
  if (mode !== 'dry-run') {
    assert.deepEqual(manifest, JSON.parse(fs.readFileSync(manifestPath)), 'Dry-run before-image drift');
  }
  let after = before.find(h => h.id === TARGET);
  const replay = !!after;
  if (!after) {
    assert.notEqual(mode, 'verify', 'Approved history has not been applied');
    assert.equal(before.length, 1);
    const keys = Object.keys(record);
    const inserted = await db.query(`INSERT INTO member_membership_history (${keys.join(',')})
      VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING to_jsonb(member_membership_history) data`,
    keys.map(k => record[k] && typeof record[k] === 'object' ? JSON.stringify(record[k]) : record[k]));
    assert.equal(inserted.rowCount, 1);
    after = inserted.rows[0].data;
  }
  assertRecord(after, record);
  const histories = await rows('member_membership_history');
  assert.equal(histories.length, 2);
  assert.deepEqual(histories.find(h => h.id === ORIGINAL), original, 'Older history must remain byte-for-byte unchanged');
  await unchanged();
  const receipt = { mode, replay, at: new Date().toISOString(), before, after, record, manifest };
  fs.writeFileSync(`${dir}/${mode}-${Date.now()}.json`, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  if (mode === 'dry-run') fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await db.query(mode === 'apply' && !replay ? 'COMMIT' : 'ROLLBACK');
  committed = true;
  console.log(JSON.stringify({ mode, replay, inserted: mode === 'apply' && !replay ? 1 : 0,
    historyId: TARGET, preservedHistoryId: ORIGINAL, structure: record.commitment_snapshot.structure_name,
    start: record.term_start_date, end: record.term_end_date, amount: record.total_with_vat,
    invoice: record.accounting_invoice_number, futurePolicy: 'unassigned', providerFinancialWrites: 0 }));
} finally {
  if (!committed) await db.query('ROLLBACK');
  await db.end();
}
