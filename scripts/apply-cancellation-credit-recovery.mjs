import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
const sql=readFileSync('supabase/migrations/202612060001_cancellation_credit_recovery.sql','utf8');
const hash=createHash('sha256').update(sql).digest('hex');
console.log('Migration SHA-256:',hash);
if(process.argv.includes('--apply')){
  if(!process.argv.includes(`--review-sha256=${hash}`))throw Error('Reviewed migration hash required');
  const db=await connectDestination();
  try{
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query(sql);
    const {rows}=await db.query(`select relrowsecurity as rls,
      has_table_privilege('anon','public.cancellation_credit_operation','SELECT') as anon_read,
      has_table_privilege('authenticated','public.cancellation_credit_operation','INSERT') as member_write,
      has_table_privilege('service_role','public.cancellation_credit_operation','UPDATE') as service_write
      from pg_class where oid='public.cancellation_credit_operation'::regclass`);
    if(!rows[0]?.rls||rows[0].anon_read||rows[0].member_write||!rows[0].service_write)throw Error('Access protection verification failed');
    await db.query('COMMIT');console.log('Applied to verified DEST; RLS and grants verified.');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
}
