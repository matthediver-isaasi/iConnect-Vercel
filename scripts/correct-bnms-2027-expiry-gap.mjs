// Inventory, transactional rollback test, hash-pinned apply and zero-write replay.
// No provider calls, invoice writes, collection, email or member edits.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
import {SOURCE_SQL} from './bnms-non-dd-apply.mjs';
import {TENANT,SOURCE,hash,historyId,assess} from './bnms-2027-expiry-gap-core.mjs';
const mode=process.argv[2], path=process.argv[3];
assert.ok(['review','dry-run','apply','replay'].includes(mode));
assert.ok(path?.startsWith('/tmp/') && path.endsWith('.json'));
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='90s'");
  // Serialise all eligibility inputs and billing entrypoints, not merely inserts.
  await db.query(`LOCK TABLE member,member_preference_value,preference_field,
    member_membership_history,organisation_membership_history,membership_billing_agreements,
    membership_payment_plans,historical_member_invoice,membership_tier_config,
    bnms_dd_alpha_adoption,bnms_dd_beta_adoption,bnms_dd_pilot_import,bnms_dd_historical_payment,
    gocardless_customers,gocardless_mandate_discovery_row IN SHARE ROW EXCLUSIVE MODE`);
  assert.equal((await db.query('select slug from tenant where id=$1',[TENANT])).rows[0]?.slug,'bnms');
  const source=(await db.query(SOURCE_SQL,[TENANT])).rows;
  const members=(await db.query(`select id,status,membership_paused,is_guest from member where tenant_id=$1`,[TENANT])).rows;
  const histories=(await db.query(`select to_jsonb(h) data from member_membership_history h where tenant_id=$1 order by id`,[TENANT])).rows.map(r=>r.data);
  const invoices=(await db.query(`select id,member_id,invoice_date::text,description,status,accounting_status,accounting_payment_status
    from historical_member_invoice where tenant_id=$1 order by id`,[TENANT])).rows;
  const configs=(await db.query(`select c.id,c.name,c.structure_match_value,c.is_active,c.effective_from::text,c.effective_to::text
    from membership_tier_config c join preference_field f on f.id=c.structure_field_id and f.tenant_id=c.tenant_id
    where c.tenant_id=$1 and f.name='member_class' and f.entity_scope='member' order by c.id`,[TENANT])).rows;
  const conflicts=new Set((await db.query(`select m.id from member m where m.tenant_id=$1 and (
    exists(select 1 from membership_billing_agreements a where a.tenant_id=m.tenant_id and
      (a.member_id=m.id or a.primary_contact_member_id=m.id or a.organization_id=m.organization_id))
    or exists(select 1 from membership_payment_plans p where p.tenant_id=m.tenant_id and (p.member_id=m.id or p.organization_id=m.organization_id))
    or exists(select 1 from organisation_membership_history h where h.tenant_id=m.tenant_id and h.organization_id=m.organization_id))`,[TENANT])).rows.map(r=>r.id));
  const records=[],excluded=[];
  for(const s of source) {
    const own=histories.find(h=>h.id===historyId(s.id));
    if(own) {
      assert.equal(mode,'replay','Already corrected; use replay');
      assert.equal(JSON.parse(own.notes).source,SOURCE);
    }
    const adjusted={...s,history_count:s.history_count-(own?1:0)};
    const result=assess(adjusted,members.find(m=>m.id===s.id),invoices.filter(i=>i.member_id===s.id),configs,conflicts.has(s.id));
    if(result.record) records.push(result.record);
    else if(!adjusted.history_count && s.preferences.membership_status==='Active') excluded.push({memberId:s.id,reason:result.reason});
  }
  const review={source:SOURCE,records,excluded}, fingerprint=hash(review);
  if(mode==='review') {
    fs.writeFileSync(path,JSON.stringify({fingerprint,...review},null,2),{flag:'wx',mode:0o600});
  } else {
    const pinned=JSON.parse(fs.readFileSync(path));
    assert.equal(hash(review),pinned.fingerprint,'Reviewed cohort/evidence changed');
    assert.ok(records.some(r=>r.member_id==='09497721-3f4b-482b-916b-b877dbff3d5b'));
    let writes=0;
    for(const row of records) {
      const existing=histories.find(h=>h.id===row.id);
      if(mode==='replay') {assert.ok(existing); for(const[k,v]of Object.entries(row))assert.deepEqual(existing[k],v);continue;}
      assert.ok(!existing);
      const keys=Object.keys(row);
      await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(k=>row[k]));
      writes++;
    }
    const after=(await db.query(`select to_jsonb(h) data from member_membership_history h where tenant_id=$1 order by id`,[TENANT])).rows.map(r=>r.data);
    for(const row of records) for(const[k,v]of Object.entries(row))assert.deepEqual(after.find(h=>h.id===row.id)?.[k],v);
    const added=new Set(records.filter(r=>!histories.some(h=>h.id===r.id)).map(r=>r.id));
    assert.deepEqual(after.filter(h=>!added.has(h.id)),histories,'Unrelated history changed');
    const receipt={mode,fingerprint,writes,records,excluded,beforeHistory:histories,committed:false};
    const journal=`${path}.${mode}.json`;
    fs.writeFileSync(journal,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
    if(mode==='apply') {
      const dry=JSON.parse(fs.readFileSync(`${path}.dry-run.json`));
      assert.equal(dry.fingerprint,fingerprint);assert.equal(dry.writes,records.length);
      // Preserve recovery evidence outside /tmp BEFORE the commit. This directory
      // is ignored by Git and deployment; never checkpoint private audit rows.
      const auditDir='generated-artifacts/bnms-2027-correction';
      assert.ok(fs.readFileSync('.gitignore','utf8').includes('/generated-artifacts/'));
      assert.ok(fs.readFileSync('.replitignore','utf8').includes('/generated-artifacts/'));
      fs.mkdirSync(auditDir,{recursive:true,mode:0o700});
      const auditPath=`${auditDir}/${fingerprint}.json`;
      const fd=fs.openSync(auditPath,'wx',0o600);
      try {fs.writeFileSync(fd,JSON.stringify(receipt,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      await db.query('COMMIT');
      fs.writeFileSync(journal,JSON.stringify({...receipt,committed:true},null,2),{mode:0o600});
      fs.writeFileSync(`${auditPath}.committed`,JSON.stringify({fingerprint,committed:true,writes,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
    }
  }
  if(mode!=='apply') await db.query('ROLLBACK');
  console.log(JSON.stringify({mode,fingerprint,eligible:records.length,excluded:excluded.reduce((a,r)=>(a[r.reason]=(a[r.reason]||0)+1,a),{}),writes:mode==='apply'?records.length:0}));
} catch(e) {await db.query('ROLLBACK').catch(()=>{});throw e;} finally {await db.end();}
