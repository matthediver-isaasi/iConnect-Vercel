import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const sources=new Set(['bnms_approved_19_xero_reconstruction','bnms_approved_annual_reconstruction','operator_approved_nine_retained_expiry_reconstructions','operator_approved_late_paid_retained_term']);
const dir='generated-artifacts/bnms-reconstructed-grace';
const migration='supabase/migrations/202612310002_bnms_reconstructed_grace_audit.sql';
const apply=process.argv.includes('--apply');
assert(process.argv.slice(2).every(a=>a==='--apply'));
const c=await connectDestination();
try{
 await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
 await c.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
 const guard=(await c.query("SELECT md5(pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure)) hash")).rows[0].hash;
 assert.equal(guard,'272c39e4e621925a610029152dd24f3e','Live guard changed; review migration before applying');
 const rows=(await c.query(`SELECT to_jsonb(h) history,to_jsonb(c) config,m.first_name,m.last_name FROM member_membership_history h
 JOIN membership_tier_config c ON c.id=h.config_id AND c.tenant_id=h.tenant_id
 JOIN member m ON m.id=h.member_id AND m.tenant_id=h.tenant_id
 WHERE h.tenant_id=$1 AND h.commitment_snapshot#>>'{config,renewal_grace_days}'='0'
 AND c.renewal_grace_days>0 ORDER BY h.id`,[tenant])).rows;
 const approved=[],excluded=[];
 for(const r of rows){
  let provenance;try{provenance=JSON.parse(r.history.notes)}catch{}
  if(!sources.has(provenance?.source)){excluded.push({id:r.history.id,memberId:r.history.member_id,name:`${r.first_name} ${r.last_name}`,reason:'Not an approved historical reconstruction'});continue;}
  const h=r.history;
  assert.equal(h.payment_method,'upfront');assert.equal(h.payment_status,'paid');
  for(const k of ['billing_agreement_id','membership_payment_quote_id','membership_successor_election_id','renewal_policy_snapshot'])assert.equal(h[k],null,k);
  assert.equal(r.config.structure_match_value,'Overseas Full');assert.equal(r.config.renewal_grace_days,90);
  assert.equal(r.config.is_active,true);
  assert.equal(h.commitment_snapshot.payment_frequency,'upfront');
  assert.equal(h.commitment_snapshot.config.renewal_grace_days,0);
  const after=structuredClone(h);after.commitment_snapshot.config.renewal_grace_days=90;
  approved.push({before:h,after,name:`${r.first_name} ${r.last_name}`});
 }
 assert.equal(approved.length,16);assert.equal(new Set(approved.map(r=>r.before.member_id)).size,16);
 assert(approved.some(r=>r.before.member_id==='575f64e2-a940-4ecf-8bda-909fa1fe32d1'));
 // No correction of evidence already reserved into a successor quote.
 const ids=approved.map(r=>r.before.id);
 assert.equal((await c.query(`SELECT count(*)::int n FROM membership_successor_election WHERE tenant_id=$1 AND previous_term_id=ANY($2::uuid[]) AND status<>'released'`,[tenant,ids])).rows[0].n,0);
 const sql=(await readFile(migration,'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
 await c.query(sql);
 for(const r of approved){
  await c.query(`INSERT INTO bnms_reconstructed_grace_audit(history_id,before_record,after_record,authority) VALUES($1,$2,$3,$4)`,
   [r.before.id,r.before,r.after,'Owner authorised correcting reconstructed BNMS zero-day grace to the current approved 90-day grace on 2026-10-15; retain all term, financial, opening-window and access-policy evidence.']);
  assert.equal((await c.query(`UPDATE member_membership_history SET commitment_snapshot=jsonb_set(commitment_snapshot,'{config,renewal_grace_days}','90'::jsonb,false) WHERE tenant_id=$1 AND id=$2`,[tenant,r.before.id])).rowCount,1);
  const actual=(await c.query('SELECT to_jsonb(h) r FROM member_membership_history h WHERE tenant_id=$1 AND id=$2',[tenant,r.before.id])).rows[0].r;
  assert.deepEqual(actual,r.after,'No field other than the grace duration may change');
 }
 // Even approved rows cannot subsequently alter prices, dates or policy again.
 for(const set of ["final_cost=final_cost+1","term_end_date=term_end_date+1","commitment_snapshot=jsonb_set(commitment_snapshot,'{config,renewal_grace_days}','91')"]){
  await c.query('SAVEPOINT safety');
  let denied=false;try{await c.query(`UPDATE member_membership_history SET ${set} WHERE id=$1`,[ids[0]])}catch{denied=true}
  await c.query('ROLLBACK TO SAVEPOINT safety');assert(denied,'Immutable guard must still reject unrelated changes');
 }
 await mkdir(dir,{recursive:true,mode:0o700});
 const report={committed:false,approved,excluded,migration};
 const file=`${dir}/${apply?'apply':'dry-run'}.json`;
 await writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
 await c.query(apply?'COMMIT':'ROLLBACK');
 report.committed=apply;
 await writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({committed:apply,repaired:approved.length,excluded,expired:approved.filter(r=>r.before.term_end_date<'2026-10-15').map(r=>({name:r.name,expiry:r.before.term_end_date})),migration:apply?migration:null}));
}catch(e){await c.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1}
finally{await c.end()}
