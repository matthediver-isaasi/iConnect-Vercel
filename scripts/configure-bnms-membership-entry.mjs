import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { TENANT, CONTINUING, PAID_FORMS, planBnmsEntryForm } from './lib/bnms-membership-entry-plan.mjs';

const migration=readFileSync('supabase/migrations/202701210004_membership_post_grace_journey.sql','utf8');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const apply=process.argv.includes('--apply');
const rehearse=process.argv.includes('--rehearse');
assert.ok(!(apply && rehearse), 'Choose apply or rehearsal, not both');
const writeTransaction=apply || rehearse;
const publicEntry='ab2d6278-686c-4604-be28-05d4bb328e03';
const renewalEntry='090be663-5429-4e46-b6ee-d824d37d6d3b';
const student='84df23c7-b148-45d7-8b57-c2e194c57ceb';
const contact='a2f08af7-75f6-49ae-84ac-bb33ab166fb6';
const ids=[...PAID_FORMS,CONTINUING,publicEntry,renewalEntry,student,contact].sort();
const db=await connectDestination();
try {
  await db.query(writeTransaction?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if(writeTransaction) await db.query('select id from tenant where id=$1 for update',[TENANT]);
  const today=(await db.query("select (now() at time zone 'UTC')::date::text as today")).rows[0].today;
  assert.equal((await db.query('select post_grace_checkout_ready() ready')).rows[0].ready,true,
    'History-aware restart checkout must be installed before changing destinations');
  const forms=(await db.query(`select to_jsonb(f) row from form f where tenant_id=$1 and id=any($2::uuid[]) order by id${writeTransaction?' for update':''}`,[TENANT,ids])).rows.map(r=>r.row);
  assert.equal(forms.length,ids.length);
  const configs=(await db.query(`select to_jsonb(c) row from membership_tier_config c where tenant_id=$1 order by id${writeTransaction?' for share':''}`,[TENANT])).rows.map(r=>r.row);
  const joining=(await db.query('select to_jsonb(j) row from membership_joining_journey j where tenant_id=$1',[TENANT])).rows[0]?.row;
  const renewal=(await db.query('select to_jsonb(j) row from membership_renewal_journey j where tenant_id=$1',[TENANT])).rows[0]?.row;
  assert.equal(joining?.form_id,publicEntry,'Joining changed; inspect rather than overwrite');
  assert.equal(renewal?.form_id,renewalEntry);
  assert.equal(renewal.mode,'questionnaire');
  assert.ok(!renewal.post_grace_form_id,'Restart already configured; inspect rather than overwrite');
  const proposed=forms.filter(f=>f.id===CONTINUING||PAID_FORMS.includes(f.id))
    .map(f=>planBnmsEntryForm(f,configs,today));
  const before={forms,configs,joining,renewal};
  const hash=digest({before,proposed,migration,today});
  const publicForm=forms.find(f=>f.id===publicEntry);
  assert.equal(publicForm.require_authentication,false);
  const entry=forms.find(f=>f.id===CONTINUING);
  const destinations=(entry.visibility_rules||[]).flatMap(r=>r.actions||[])
    .filter(a=>a.action_type==='open_form').map(a=>a.destination_form_id).sort();
  assert.deepEqual(destinations,[...PAID_FORMS,student,contact].sort());
  if(writeTransaction) {
    assert.ok(process.argv.includes(`--review-sha256=${hash}`),'Fresh exact snapshot/migration review hash required');
    await db.query(migration.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
    for(const next of proposed) {
      const old=forms.find(f=>f.id===next.id);
      const changed=Object.keys(next).filter(k=>JSON.stringify(next[k])!==JSON.stringify(old[k]));
      assert.ok(changed.every(k=>['fields','require_authentication','mutation_access_policy','entity_pipelines'].includes(k)));
      const columns=changed.map(k=>`"${k}"`).join(',');
      const result=await db.query(`update form set (${columns})=(select ${columns} from jsonb_populate_record(null::public.form,$3::jsonb))
        where tenant_id=$1 and id=$2`,[TENANT,next.id,JSON.stringify(next)]);
      assert.equal(result.rowCount,1);
    }
    const actor='approved:bnms-four-state-entry-routing';
    const j=(await db.query('select save_membership_joining_journey($1,$2,$3,$4) setting',[TENANT,actor,CONTINUING,joining.revision])).rows[0].setting;
    const r=(await db.query('select save_membership_renewal_journey($1,$2,$3,$4,$5,$6) setting',[TENANT,actor,renewal.mode,renewalEntry,renewal.revision,CONTINUING])).rows[0].setting;
    const afterForms=(await db.query('select to_jsonb(f) row from form f where tenant_id=$1 and id=any($2::uuid[]) order by id',[TENANT,ids])).rows.map(r=>r.row);
    for(const old of forms) {
      const actual=afterForms.find(f=>f.id===old.id);
      const expected=proposed.find(f=>f.id===old.id)||old;
      // Database-maintained timestamp may advance; every other field must agree.
      const {updated_at:a,...restA}=actual;
      const {updated_at:b,...restB}=expected;
      assert.deepEqual(restA,restB);
    }
    await db.query(`insert into membership_entry_configuration_audit(tenant_id,actor,snapshot_hash,before_snapshot,after_snapshot)
      values($1,$2,$3,$4,$5)`,[TENANT,actor,hash,JSON.stringify(before),JSON.stringify({forms:afterForms,joining:j,renewal:r})]);
    await db.query(rehearse?'ROLLBACK':'COMMIT');
  } else await db.query('ROLLBACK');
  console.log(JSON.stringify({project:PROJECT,applied:apply,rehearsed:rehearse,reviewSha256:hash,
    proposedForms:proposed.map(f=>({id:f.id,name:f.name})),
    publicJoiningUnchanged:true,studentApprovalUnchanged:true,contactUnchanged:true,
    note:'Post-grace route requires matching application rollout; no payments or submissions invoked.'},null,2));
} catch(error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
