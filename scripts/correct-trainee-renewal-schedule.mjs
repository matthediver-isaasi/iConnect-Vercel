import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const formId = 'fa639380-b5a0-4a5c-9d56-fb321d5d0d19';
const oldSchedule = '5bf28257-540e-4aff-9b15-bfbaf0290396';
const newSchedule = '5ab8875e-25a7-4224-a8b9-b9ff53871800';
const db = await connectDestination();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'");
  const source = (await db.query('select to_jsonb(f) row from form f where tenant_id=$1 and id=$2 for update',
    [tenant, formId])).rows[0]?.row;
  assert.ok(source);
  assert.equal(source.is_active, false, 'Do not amend a published payment form through this correction');
  const schedules = (await db.query(`select id,structure_scope_type,structure_field_id
    from membership_tier_config where tenant_id=$1 and structure_match_value='Trainee'`, [tenant])).rows;
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].id, newSchedule);
  assert.equal(schedules[0].structure_scope_type, 'member');
  assert.equal(schedules[0].structure_field_id, '87f120ff-92e6-4d52-944b-9ba9d7b1fac0');
  const expected = structuredClone(source);
  const payment = expected.fields.find(f => f.type === 'membership_payment');
  assert.equal(payment.membership_config_id, oldSchedule);
  assert.deepEqual(payment.membership_schedule_mapping.entries, [{ value: 'Trainee', config_id: oldSchedule }]);
  await mkdir('generated-artifacts/form-config-backups', { recursive: true });
  await writeFile('generated-artifacts/form-config-backups/trainee-schedule-correction.json',
    JSON.stringify({ formId, fields: source.fields }, null, 2), { flag: 'wx', mode: 0o600 });
  payment.membership_config_id = newSchedule;
  payment.membership_schedule_mapping.entries[0].config_id = newSchedule;
  await db.query('update form set fields=$1::jsonb where id=$2 and tenant_id=$3',
    [JSON.stringify(expected.fields), formId, tenant]);
  assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1', [formId])).rows[0].row, expected);
  await db.query('COMMIT');
  console.log(JSON.stringify({ corrected: true, formId, traineeSchedule: newSchedule, otherSettingsUnchanged: true }));
} catch (e) { await db.query('ROLLBACK'); throw e; }
finally { await db.end(); }
