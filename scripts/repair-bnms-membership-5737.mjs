import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { buildPlan, ORIGINAL, TARGET, RELATED, INVOICE, assertRecord } from './lib/bnms-membership-5737-plan.mjs';
import { MEMBER, TENANT } from './lib/bnms-membership-5734-plan.mjs';
const mode = process.argv[2] || 'dry-run';
assert.ok(['dry-run', 'apply', 'verify'].includes(mode));
const { evidence: e } = await import('./inspect-bnms-membership-5737.mjs');
const dir = 'generated-artifacts/bnms-membership-5737';
const path = `${dir}/approved-dry-run.json`;
const saved = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : null;
assert.ok(mode === 'dry-run' || saved, 'A successful dry-run is required');
const plan = buildPlan(e, saved?.original);
const manifest = { ...plan, owner: e.owner, preferences: e.preferences, configs: e.configs,
  related: Object.fromEntries(RELATED.map(t => [t, e[t]])) };
if (saved) assert.deepEqual(manifest, saved, 'Approved before-image drift');
const db = await connectDestination();
try {
  await db.query(mode === 'verify' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if (mode !== 'verify') {
    await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
    await db.query('SELECT id FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [MEMBER, TENANT]);
  }
  const rows = async t => (await db.query(`SELECT to_jsonb(r) data FROM ${t} r WHERE member_id=$1 AND tenant_id=$2 ORDER BY id`, [MEMBER, TENANT])).rows.map(r => r.data);
  const unchanged = async () => {
    assert.deepEqual((await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2', [MEMBER, TENANT])).rows[0].data, e.owner);
    assert.deepEqual((await db.query(`SELECT v.id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
      WHERE v.member_id=$1 AND f.tenant_id=$2 ORDER BY v.id`, [MEMBER, TENANT])).rows, e.preferences);
    assert.deepEqual((await db.query(`SELECT to_jsonb(c) data FROM membership_tier_config c JOIN preference_field f ON f.id=c.structure_field_id
      WHERE c.tenant_id=$1 AND f.tenant_id=$1 AND f.name='member_class' AND c.structure_match_value='Overseas Full' ORDER BY c.id`, [TENANT])).rows.map(r => r.data), e.configs);
    for (const t of RELATED) assert.deepEqual(await rows(t), e[t], t);
  };
  await unchanged();
  const before = await rows('member_membership_history');
  assert.deepEqual(before, e.member_membership_history, 'History changed during refresh');
  const allocated = (await db.query('SELECT id FROM member_membership_history WHERE accounting_invoice_id=$1 OR xero_invoice_id=$1', [INVOICE])).rows;
  assert.ok(allocated.every(h => h.id === ORIGINAL), 'Competing allocation');
  const old = before.find(h => h.id === ORIGINAL);
  const replay = old.term_key !== null;
  let updated = 0;
  if (replay) assertRecord(old, plan.record);
  else {
    assert.notEqual(mode, 'verify');
    assert.deepEqual(old, plan.original);
    const keys = Object.keys(plan.record).filter(k => JSON.stringify(plan.record[k]) !== JSON.stringify(old[k]));
    const result = await db.query(`UPDATE member_membership_history SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}
      WHERE id=$${keys.length + 1} AND tenant_id=$${keys.length + 2} AND to_jsonb(member_membership_history)=$${keys.length + 3}::jsonb RETURNING id`,
    [...keys.map(k => typeof plan.record[k] === 'object' && plan.record[k] !== null ? JSON.stringify(plan.record[k]) : plan.record[k]),
      ORIGINAL, TENANT, JSON.stringify(old)]);
    assert.equal(result.rowCount, 1);
    updated = 1;
  }
  const after = await rows('member_membership_history');
  assert.equal(after.length, 2);
  assertRecord(after.find(h => h.id === ORIGINAL), plan.record);
  assert.deepEqual(after.find(h => h.id === TARGET), plan.current, 'Current term changed');
  await unchanged();
  fs.writeFileSync(`${dir}/${mode}-${Date.now()}.json`, JSON.stringify({ mode, replay, before, after, updated }, null, 2), { mode: 0o600 });
  await db.query(mode === 'apply' && !replay ? 'COMMIT' : 'ROLLBACK');
  if (mode === 'dry-run' && !saved) fs.writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ mode, replay, committedUpdates: mode === 'apply' ? updated : 0, rehearsedUpdates: updated, histories: 2 }));
} finally { await db.query('ROLLBACK'); await db.end(); }
