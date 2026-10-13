import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import pg from 'pg';
import { importHistoricalInvoices, TENANT } from './import-bnms-historical-invoices.mjs';

test('historical storage migration: RLS, narrow grants, negative amounts and idempotency', async () => {
  const h = await createLocalPostgresHarness('historical-invoices-');
  const run = (cmd,args,input) => {
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();
  };
  const sql=text=>run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-At'],text);
  let started=false;
  try{
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE xero_token(app_tenant_id uuid,tenant_id text);
      CREATE TABLE operational_invoice(tenant_id uuid,invoice_number text,member_id uuid,immutable_marker text);
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;`);
    const migration=readFileSync('supabase/migrations/20261202_historical_member_invoices.sql','utf8');
    sql(migration);sql(migration);
    assert.equal(sql("SELECT count(*) FROM pg_class WHERE relname IN ('historical_member_invoice','historical_invoice_import','historical_invoice_import_row') AND relrowsecurity"),'3');
    for(const role of ['anon','authenticated'])assert.equal(sql(`SELECT has_table_privilege('${role}','historical_member_invoice','SELECT')`),'f');
    assert.equal(sql("SELECT has_column_privilege('service_role','historical_member_invoice','xero_document_id','UPDATE')"),'t');
    assert.equal(sql("SELECT has_column_privilege('service_role','historical_member_invoice','amount_minor','UPDATE')"),'f');
    sql(`INSERT INTO tenant VALUES ('00000000-0000-4000-8000-000000000001');INSERT INTO member(id) VALUES ('00000000-0000-4000-8000-000000000002');
      INSERT INTO historical_invoice_import(id,tenant_id,source_sha256,worksheet) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',repeat('a',64),'To import good');
      SET ROLE service_role;
      INSERT INTO historical_member_invoice(tenant_id,member_id,import_id,source_row,source_key,invoice_number,invoice_date,amount_minor,record_kind,xero_company_id)
      VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',2,'invoice:CN-1','CN-1','2020-01-01',-100,'credit','company');
      INSERT INTO historical_member_invoice SELECT * FROM historical_member_invoice ON CONFLICT DO NOTHING;
      RESET ROLE;`);
    assert.equal(sql('SELECT count(*) FROM historical_member_invoice'),'1');
    assert.equal(sql("SELECT amount_minor || ':' || invoice_date || ':' || (currency IS NULL) || ':' || (status IS NULL) FROM historical_member_invoice"),'-100:2020-01-01:true:true');
    const member = '00000000-0000-4000-8000-000000000004';
    sql(`INSERT INTO tenant VALUES ('${TENANT}');INSERT INTO member(id,tenant_id) VALUES ('${member}','${TENANT}');
      INSERT INTO xero_token VALUES ('${TENANT}','company');
      INSERT INTO operational_invoice VALUES ('${TENANT}','OLD-1','${member}','must remain unchanged');`);
    const db = new pg.Client({ host:h.socket,port:h.port,user:'postgres',database:'postgres' });
    await db.connect();
    try {
      const rows = [
        ['NEW-1',100],['OLD-1',200],['Overpayment',-100],['CREDIT-1',-50],['ZERO-1',0],
      ].map(([invoice_number,amount_minor],i)=>({
        source_row:i+2,member_id:member,invoice_number,amount_minor,invoice_date:'2020-01-01',description:'Original',
      }));
      const input={rows,source_sha256:'b'.repeat(64),worksheet:'To import good'};
      const preview=await importHistoricalInvoices(db,input,{log:()=>{}});
      assert.equal(preview.imported,4);assert.equal(preview.existing,1);
      assert.equal(sql(`SELECT count(*) FROM historical_member_invoice WHERE tenant_id='${TENANT}'`),'0');
      const applied=await importHistoricalInvoices(db,input,{apply:true,log:()=>{}});
      assert.equal(applied.imported,4);assert.equal(applied.existing,1);assert.equal(applied.before2025,4);
      const replay=await importHistoricalInvoices(db,input,{apply:true,log:()=>{}});
      assert.equal(replay.imported,0);assert.equal(replay.replayed,5);
      const afterPreview=await importHistoricalInvoices(db,input,{log:()=>{}});
      assert.equal(afterPreview.imported,0);assert.equal(afterPreview.existing,5);
      const reexport=await importHistoricalInvoices(db,{...input,source_sha256:'c'.repeat(64)},{apply:true,log:()=>{}});
      assert.equal(reexport.imported,0);assert.equal(reexport.existing,5);
      assert.equal(sql(`SELECT count(*) FROM historical_member_invoice WHERE tenant_id='${TENANT}'`),'4');
      assert.equal(sql('SELECT immutable_marker FROM operational_invoice'),'must remain unchanged');
      await assert.rejects(importHistoricalInvoices(db,{...input,source_sha256:'d'.repeat(64),rows:[{...rows[0],amount_minor:999}]},{apply:true,log:()=>{}}),/identity conflict/);
      assert.equal(sql(`SELECT amount_minor FROM historical_member_invoice WHERE invoice_number='NEW-1'`),'100');
    } finally { await db.end(); }
  }finally{
    if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
