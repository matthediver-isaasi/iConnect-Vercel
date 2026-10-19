import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
import {completeRecord} from './complete-bnms-expiry-gap-core.mjs';
const [mode,path]=process.argv.slice(2),root='generated-artifacts/bnms-2027-correction';
assert.ok(['dry-run','apply','replay'].includes(mode));
assert.ok(path?.startsWith(`${root}/xero-evidence-`));
const bytes=fs.readFileSync(path),e=JSON.parse(bytes),hash=createHash('sha256').update(bytes).digest('hex');
assert.ok(Date.now()-Date.parse(e.capturedAt)<1800000,'Evidence expired');
assert.equal(e.rows.length,18);
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const journal=`${root}/completion-${hash}`;
const db=await connectDestination();
try {
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await db.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='90s'");
 await db.query(`LOCK TABLE member_membership_history,membership_tier_config,member,member_preference_value,
   preference_field,membership_billing_agreements,membership_payment_plans,membership_successor_election,
   membership_payment_quote IN SHARE ROW EXCLUSIVE MODE`);
 const ids=e.rows.map(r=>r.history_id);
 const current=(await db.query('select to_jsonb(h) r from member_membership_history h where tenant_id=$1 and id=any($2::uuid[]) order by id',[tenant,ids])).rows.map(r=>r.r);
 assert.equal(current.length,18);
 const before=mode==='replay'?JSON.parse(fs.readFileSync(`${journal}.apply.json`)).before:current;
 const changes=[];
 for(const r of before) {
   assert.equal(r.term_key,null);assert.equal(r.config_id,null);
   assert.equal(r.membership_payment_quote_id,null);assert.equal(r.membership_successor_election_id,null);
   const evidence=e.rows.find(x=>x.history_id===r.id);
   const member=(await db.query(`select m.status,m.membership_paused,m.email,v.value member_class
     from member m join member_preference_value v on v.member_id=m.id
     join preference_field f on f.id=v.field_id and f.tenant_id=m.tenant_id
     where m.id=$1 and m.tenant_id=$2 and f.name='member_class' and f.entity_scope='member'`,[r.member_id,tenant])).rows;
   assert.equal(member.length,1);assert.equal(member[0].member_class,r.field_value);
   assert.equal(member[0].email,evidence.email);assert.equal(member[0].status,'active');assert.ok(!member[0].membership_paused);
   const configs=(await db.query(`select to_jsonb(c) r from membership_tier_config c
     join preference_field f on f.id=c.structure_field_id and f.tenant_id=c.tenant_id
     where c.tenant_id=$1 and f.name='member_class' and f.entity_scope='member'
     and c.structure_match_value=$2 and c.is_active and c.effective_from<='2026-10-19'
     and (c.effective_to is null or c.effective_to>='2026-10-19')`,[tenant,r.field_value])).rows;
   assert.equal(configs.length,1);
   const conflict=(await db.query(`select id from membership_billing_agreements where tenant_id=$1 and member_id=$2
     union all select id from membership_payment_plans where tenant_id=$1 and member_id=$2
     union all select id from membership_payment_quote where tenant_id=$1 and member_id=$2 and cancelled_for_switch_at is null
     union all select id from member_membership_history where tenant_id=$1 and member_id=$2 and id<>$3`,
     [tenant,r.member_id,r.id])).rows;
   assert.equal(conflict.length,0,'New financial activity; stop');
   const result=completeRecord(r,configs[0].r,evidence,e.paymentEvidence.find(p=>p.memberId===r.member_id),hash);
   if(result.linked){
     const collisions=(await db.query(`select id from member_membership_history where tenant_id=$1 and id<>$2
       and (xero_invoice_id::text=$3 or accounting_invoice_id::text=$3)
       union all select id from organisation_membership_history where tenant_id=$1 and
       (xero_invoice_id::text=$3 or accounting_invoice_id::text=$3)`,[tenant,r.id,result.patch.xero_invoice_id])).rows;
     assert.equal(collisions.length,0,'Invoice already linked');
   }
   changes.push({id:r.id,...result});
 }
 assert.equal(changes.filter(c=>c.priced).length,7);assert.equal(changes.filter(c=>c.linked).length,9);
 const receipt={mode,evidenceHash:hash,before,changes,committed:false};
 if(mode==='apply'){
   const dry=JSON.parse(fs.readFileSync(`${journal}.dry-run.json`));
   assert.deepEqual(dry.before,before);assert.deepEqual(dry.changes,changes);
   fs.writeFileSync(`${journal}.apply.json`,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
 }
 for(const change of changes){
   if(mode!=='replay'){
     const keys=Object.keys(change.patch);
     assert.equal((await db.query(`update member_membership_history set ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')}
       where tenant_id=$${keys.length+1} and id=$${keys.length+2}`,
       [...keys.map(k=>typeof change.patch[k]==='object'&&change.patch[k]!==null?JSON.stringify(change.patch[k]):change.patch[k]),tenant,change.id])).rowCount,1);
   }
   const saved=(await db.query('select to_jsonb(h) r from member_membership_history h where tenant_id=$1 and id=$2',[tenant,change.id])).rows[0].r;
   const expected={...before.find(h=>h.id===change.id),...change.patch};
   // paid_at has equivalent PostgreSQL/JS timestamp spellings.
   if(saved.paid_at)saved.paid_at=new Date(saved.paid_at).toISOString();
   assert.deepEqual(saved,expected,'Unintended history change');
 }
 if(mode==='apply'){
   await db.query('COMMIT');
   fs.writeFileSync(`${journal}.committed.json`,JSON.stringify({committed:true,evidenceHash:hash,rows:18}),{flag:'wx',mode:0o600});
 }else{
   await db.query('ROLLBACK');
   fs.writeFileSync(`${journal}.${mode}.json`,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
 }
 console.log(JSON.stringify({mode,datesAndStructures:18,verifiedFinancials:7,verifiedInvoiceLinks:9,
   unknownPackageAmounts:2,identityHeld:9,committed:mode==='apply',writes:mode==='apply'?18:0}));
}catch(err){await db.query('ROLLBACK').catch(()=>{});throw err;}finally{await db.end();}
