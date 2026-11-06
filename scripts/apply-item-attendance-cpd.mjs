import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
const migration='supabase/migrations/202701190001_item_attendance_cpd.sql';
const sql=readFileSync(migration,'utf8');
const hash=createHash('sha256').update(sql).digest('hex');
if(!process.argv.includes('--apply')) {
  console.log(JSON.stringify({migration,sha256:hash,writes:false}));
} else {
  assert(process.argv.includes(`--review-sha256=${hash}`),'Reviewed migration hash required');
  const db=await connectDestination();
  try{
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    const prior=await db.query(`select proname,pg_get_functiondef(oid) definition from pg_proc
      where pronamespace='public'::regnamespace and proname in
      ('record_event_cpd_points_award','evaluate_event_cpd_points_reprocessing_row','item_cpd_mode')`);
    assert(!prior.rows.some(r=>r.proname==='item_cpd_mode'),'Migration already present; do not replay renames');
    assert.equal(prior.rows.length,2);
    assert(prior.rows.find(r=>r.proname==='record_event_cpd_points_award').definition.includes('record_event_cpd_points_award_unreviewed'),
      'Unexpected award engine; review before migrating');
    mkdirSync('generated-artifacts/item-cpd-migration',{recursive:true,mode:0o700});
    writeFileSync(`generated-artifacts/item-cpd-migration/before-${Date.now()}.json`,
      JSON.stringify({hash,migration,functions:prior.rows}),{flag:'wx',mode:0o600});
    await db.query(sql);
    for(const signature of [
      'record_event_cpd_points_award(jsonb)','evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid)',
      'item_cpd_candidates(uuid,text,uuid,uuid)','item_cpd_certificate_state(uuid,text,uuid,uuid)',
    ]) {
      const {rows:[r]}=await db.query(`select prosecdef,proconfig,
        has_function_privilege('service_role',oid,'execute') service,
        has_function_privilege('authenticated',oid,'execute') authenticated,
        has_function_privilege('anon',oid,'execute') anon
        from pg_proc where oid=$1::regprocedure`,[signature]);
      assert.equal(r.prosecdef,true);assert.deepEqual(r.proconfig,['search_path=public']);
      assert.equal(r.service,true);assert.equal(r.authenticated,false);assert.equal(r.anon,false);
    }
    const {rows:[configured]}=await db.query(`select
      (select count(*) from event_agenda_item where cpd_points is not null)
      +(select count(*) from complex_event_session where cpd_points is not null) as total`);
    assert.equal(Number(configured.total),0,'Existing events must remain on their previous rules');
    await db.query('COMMIT');
    console.log(JSON.stringify({applied:true,migration,sha256:hash,serviceOnly:true,existingEventsUnchanged:true,noAwardsOrEmails:true}));
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
}
