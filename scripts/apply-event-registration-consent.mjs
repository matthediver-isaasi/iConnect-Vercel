#!/usr/bin/env node
// Explicit, hash-pinned DEST operation. No customer-data mutations or test fixtures.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const project = 'lvmzliemqnieeoruhkik';
const version = '202610260001';
const name = 'event_registration_consent';
const migration = `${version}_${name}.sql`;
const reviewedHash = 'e0ee36cee5693a4c8fb9113cc416b4ddfb3466c3a3849f7e54e14a8dbf8dce87';
const tables = ['event_registration_communication', 'event_registration_consent'];
const functions = ['delete_event_registration_communication', 'set_event_registration_communication', 'complete_event_registration_consent'];
const args = process.argv.slice(2);
let client;
let committed = false;
try {
  if (args.length > 1 || (args.length && !['--preflight', '--apply', '--verify'].includes(args[0]))) throw new Error('Invalid mode');
  const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (sha256 !== reviewedHash) throw new Error('Reviewed SQL changed');
  if (!args.length) {
    console.log(JSON.stringify({ project, migration, sha256, offline: true }));
  } else {
    const target = destinationTarget(process.env);
    const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
    if (!response.ok) throw new Error('Provider CA unavailable');
    client = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 15000,
      ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
    await client.connect();
    const apply = args[0] === '--apply';
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('migration:202610260001_event_registration_consent',0))");
    // Resolve every prerequisite column without reading customer rows.
    for (const query of [
      'select id,tenant_id from public.event limit 0',
      'select id,tenant_id from public.complex_event limit 0',
      'select id,tenant_id,email,role_id,login_enabled,communications_opted_out_all from public.member limit 0',
      'select id,tenant_id,is_active,is_public,system_key,member_enabled,name,display_order from public.communication_category limit 0',
      'select tenant_id,category_id,role_id from public.communication_category_role limit 0',
      'select tenant_id,email,unsubscribe_type from public.email_unsubscribe limit 0',
      'select tenant_id,email,communication_category_id,opted_out,subscribed_at from public.email_subscriber limit 0',
    ]) await client.query(query);
    const prerequisite = (await client.query(`select
      to_regprocedure('public.set_email_preference_category_state(uuid,text,uuid,uuid,boolean,uuid)') is not null as atomic,
      exists(select 1 from pg_indexes where schemaname='public' and tablename='email_subscriber'
        and indexdef like 'CREATE UNIQUE INDEX% (tenant_id, email, communication_category_id) WHERE (communication_category_id IS NOT NULL)') as unique_subscriber`)).rows[0];
    if (!prerequisite.atomic || !prerequisite.unique_subscriber) throw new Error('Prerequisite drift');
    const before = (await client.query(`select
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname=any($1)) as tables,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($2)) as functions`, [tables, functions])).rows[0];
    const history = (await client.query('select version,name,statements from supabase_migrations.schema_migrations where version=$1', [version])).rows;
    if (args[0] === '--preflight') {
      console.log(JSON.stringify({ project, migration, sha256, prerequisite, before, history: history.map(({version,name}) => ({version,name})), readOnly: true }));
    } else {
      if (apply) {
        if (before.tables || before.functions || history.length) throw new Error('Existing migration objects/history; stop for drift review');
        await client.query(sql);
        await client.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)', [version, name, [sql]]);
      } else if (history.length !== 1 || history[0].name !== name || history[0].statements?.join('') !== sql) {
        throw new Error('Migration bookkeeping mismatch');
      }
      const tableMetadata = (await client.query(`select c.relname,c.relrowsecurity,
        (select count(*)::int from pg_policy where polrelid=c.oid) as policies,
        (select count(*)::int from pg_attribute where attrelid=c.oid and attnum>0 and not attisdropped) as columns,
        (select count(*)::int from pg_constraint where conrelid=c.oid and contype in ('p','u','c')) as constraints
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by c.relname`, [tables])).rows;
      if (tableMetadata.length !== 2 || tableMetadata.some(t => !t.relrowsecurity || t.policies !== 0
        || t.columns !== (t.relname === tables[0] ? 4 : 14)
        || t.constraints !== (t.relname === tables[0] ? 2 : 4))) throw new Error('Table definition mismatch');
      const functionMetadata = (await client.query(`select p.proname,p.prosrc,p.prosecdef,p.proconfig
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($1)`, [functions])).rows;
      if (functionMetadata.length !== 3) throw new Error('Function count mismatch');
      for (const f of functionMetadata) {
        const body = sql.match(new RegExp(`function public\\.${f.proname}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$`))?.[1];
        if (body !== f.prosrc || !f.prosecdef || f.proconfig?.join() !== 'search_path=public') throw new Error('Function definition mismatch');
      }
      for (const table of tables) {
        const grants = (await client.query(`select role,
          has_table_privilege(role,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as any_access,
          has_table_privilege(role,$1,'SELECT') and has_table_privilege(role,$1,'INSERT')
          and has_table_privilege(role,$1,'UPDATE') and has_table_privilege(role,$1,'DELETE') as crud
          from unnest(array['anon','authenticated','service_role']) role`, [`public.${table}`])).rows;
        if (grants.some(g => g.role === 'service_role' ? !g.crud : g.any_access)) throw new Error('Table grants mismatch');
      }
      const privileges = (await client.query(`select p.proname,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($1)`, [functions])).rows;
      if (privileges.some(p => p.anon || p.authenticated || (p.proname !== functions[0] && !p.service))) throw new Error('Function grants mismatch');
      const triggers = (await client.query(`select c.relname,t.tgtype,t.tgenabled,p.proname
        from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid
        where t.tgname='delete_event_registration_communication' and t.tgrelid in ('public.event'::regclass,'public.complex_event'::regclass)`)).rows;
      if (triggers.length !== 2 || triggers.some(t => t.tgtype !== 9 || t.tgenabled !== 'O' || t.proname !== functions[0])) throw new Error('Deletion triggers mismatch');
      await client.query('SET LOCAL ROLE service_role');
      await client.query('select category_ids from public.event_registration_communication limit 0');
      await client.query('select id from public.event_registration_consent limit 0');
      await client.query('RESET ROLE');
      console.log(JSON.stringify({ project, migration, sha256, mode: args[0], tableMetadata,
        exactFunctionBodies: true, privateGrants: true, triggers, serviceRoleReads: true, bookkeeping: true }));
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    committed = apply;
    console.log(JSON.stringify({ project, committed, readOnly: !apply }));
  }
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {});
  // Do not expose connection details or arbitrary provider error messages.
  console.error(JSON.stringify({ project, committed, error: 'Migration operation failed', code: error.code || null,
    reason: error instanceof pg.DatabaseError ? 'Database check failed' : error.message }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
