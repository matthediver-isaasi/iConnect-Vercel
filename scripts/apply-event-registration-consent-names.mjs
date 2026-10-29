#!/usr/bin/env node
// Destination-only additive migration; default mode is offline hash review.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const version='202610290001', name='event_registration_consent_names';
const sql=await readFile(new URL(`../supabase/migrations/${version}_${name}.sql`,import.meta.url),'utf8');
const hash=createHash('sha256').update(sql).digest('hex');
const args=process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({migration:`${version}_${name}`,sha256:hash,offline:true}));
} else {
  if(args.length!==2 || args[0]!=='--apply' || args[1]!==`--review-sha256=${hash}`) throw new Error('Explicit apply and matching review hash required');
  const target=destinationTarget(process.env);
  const ca=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if(!ca.ok)throw new Error('Provider CA unavailable');
  const db=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:15000,
    ssl:{rejectUnauthorized:true,ca:await ca.text(),servername:target.hostname}});
  try {
    await db.connect();
    await db.query('begin');
    await db.query("set local lock_timeout='10s'; set local statement_timeout='60s'");
    await db.query("select pg_advisory_xact_lock(hashtextextended('migration:event_registration_consent_names',0))");
    const history=(await db.query('select name,statements from supabase_migrations.schema_migrations where version=$1',[version])).rows;
    if(history.length) {
      if(history[0].name!==name || history[0].statements?.join('')!==sql)throw new Error('Migration history drift');
    } else {
      const original=await readFile(new URL('../supabase/migrations/202610260001_event_registration_consent.sql',import.meta.url),'utf8');
      const expected=original.split('create or replace function public.complete_event_registration_consent(')[1].split('$$')[1].trim();
      const current=(await db.query(`select prosrc from pg_proc where oid='public.complete_event_registration_consent(uuid,text,uuid,uuid[])'::regprocedure`)).rows[0]?.prosrc.trim();
      if(current!==expected)throw new Error('Completion function drift; review before replacing');
      await db.query('select first_name,last_name from public.email_subscriber limit 0');
      await db.query(sql);
      await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',[version,name,[sql]]);
    }
    const actual=(await db.query(`select prosrc from pg_proc where oid='public.complete_event_registration_consent(uuid,text,uuid,uuid[])'::regprocedure`)).rows[0].prosrc.trim();
    if(actual!==sql.split('$$')[1].trim())throw new Error('Completion definition mismatch');
    await db.query('select first_name,last_name from public.event_registration_consent limit 0');
    for(const role of ['anon','authenticated']) {
      const privileges=(await db.query(`select
        has_table_privilege($1,'public.event_registration_consent','SELECT') as readable,
        has_function_privilege($1,'public.complete_event_registration_consent(uuid,text,uuid,uuid[])','EXECUTE') as executable`,[role])).rows[0];
      if(privileges.readable || privileges.executable)throw new Error('Private capability grant drift');
    }
    await db.query('commit');
    console.log(JSON.stringify({project:'lvmzliemqnieeoruhkik',migration:`${version}_${name}`,sha256:hash,verified:true,alreadyApplied:!!history.length}));
  } catch(error) {
    await db.query('rollback').catch(()=>{});
    console.error('Destination migration failed:',error.code || 'verification/connection failure');
    process.exitCode=1;
  } finally { await db.end(); }
}
