import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('disposable PostgreSQL: signed PDFs can only be superseded through recorded, append-only history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agreement-pdf-history-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Command failed');
    return result.stdout.trim();
  };
  const sql = query => run('psql', ['-h', socket, '-p', '55463', '-U', 'postgres', '-d', 'postgres', '-qXAt', '-v', 'ON_ERROR_STOP=1'], query);
  const service = query => sql(`SET ROLE service_role; ${query}`).split('\n').at(-1);
  const tenant = '00000000-0000-0000-0000-000000000001';
  const quote = '00000000-0000-0000-0000-000000000002';
  const version = '00000000-0000-0000-0000-000000000003';
  const envelope = '00000000-0000-0000-0000-000000000009';
  const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
  const oldPath = `${tenant}/${envelope}/final.pdf`, newPath = `${tenant}/${envelope}/final-proposal-layout-v2.pdf`;
  const supersede = (expectedPath = oldPath, expectedHash = oldHash, path = newPath, hash = newHash) =>
    JSON.parse(service(`SELECT supersede_sales_agreement_final_pdf('${envelope}','${expectedPath}','${expectedHash}','${path}','${hash}','proposal-layout-v2')`));
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-F -k ${socket} -p 55463 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      GRANT USAGE ON SCHEMA auth TO service_role,anon,authenticated;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid,bucket_id text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE TABLE sales_quote(id uuid PRIMARY KEY,tenant_id uuid,current_version integer,row_version integer,updated_at timestamptz,updated_by text,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,version_number integer,status text,terms_snapshot jsonb,updated_at timestamptz,valid_until timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_delivery_token(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,quote_version_id uuid,token_hash bytea,recipient_email text,activated_at timestamptz,revoked_at timestamptz,expires_at timestamptz);
      CREATE TABLE sales_quote_customer_decision(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,quote_id uuid,quote_version_id uuid UNIQUE,token_id uuid,decision text,customer_name text,customer_role text,purchase_order_reference text,customer_reference text,decline_reason text,agreement boolean,idempotency_key text,request_metadata jsonb);
      CREATE TABLE sales_quote_delivery_audit(tenant_id uuid,quote_id uuid,quote_version_id uuid,token_id uuid,event_type text,recipient_email text,request_metadata jsonb);
      CREATE TABLE sales_quote_status_history(tenant_id uuid,quote_id uuid,quote_version_id uuid,from_status text,to_status text,actor_id text,actor_type text,note text);
      INSERT INTO sales_quote VALUES('${quote}','${tenant}',1,1,now(),'actor');
      INSERT INTO sales_quote_version VALUES('${version}','${tenant}','${quote}',1,'sent','{"legalHtml":"<p>Terms</p>"}',now(),now()+interval '30 days');
    `);
    sql(readFileSync('supabase/migrations/202610190001_sales_agreements.sql', 'utf8'));
    sql('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role');
    sql(`INSERT INTO sales_agreement_envelope(id,tenant_id,quote_id,quote_version_id,sender_actor_id,sender_actor_type,sender,contact,sender_consent,sender_evidence,snapshot,document_hash,customer,finalization_status,final_pdf_path,final_pdf_hash,finalized_at)
      VALUES('${envelope}','${tenant}','${quote}','${version}','actor','tenant_user','{"email":"seller@example.org"}','{"email":"buyer@example.org"}',true,'{}',
      '{"version":{"id":"${version}","terms_snapshot":{"legalHtml":"<p>Terms</p>"}}}','${'c'.repeat(64)}','{"name":"Buyer"}','complete','${oldPath}','${oldHash}',now())`);
    const migration = readFileSync('supabase/migrations/202702040001_sales_agreement_final_pdf_history.sql', 'utf8');
    sql(migration);
    const evidence = () => sql(`SELECT md5(snapshot::text || sender::text || customer::text || document_hash || finalized_at::text) FROM sales_agreement_envelope`);
    const before = evidence();

    // Direct switches (even with a forged history row from another transaction) stay blocked.
    assert.throws(() => service(`UPDATE sales_agreement_envelope SET final_pdf_path='${newPath}',final_pdf_hash='${newHash}'`), /immutable/);
    assert.throws(() => service(`INSERT INTO sales_agreement_final_pdf_history(envelope_id,tenant_id,superseded_path,superseded_hash,replacement_path,replacement_hash,layout)
      VALUES('${envelope}','${tenant}','${oldPath}','${oldHash}','${newPath}','${newHash}','x')`), /permission denied/);
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`SET ROLE ${role}; SELECT supersede_sales_agreement_final_pdf('${envelope}','a','b','c','${newHash}','x')`), /permission denied/);
      assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM sales_agreement_final_pdf_history`), /permission denied/);
    }
    // Stale expectation or foreign folder is rejected without changes.
    assert.deepEqual(supersede(oldPath, 'd'.repeat(64)), { ok: false, reason: 'changed_concurrently' });
    assert.throws(() => supersede(oldPath, oldHash, 'other-tenant/file.pdf'), /new object in the agreement folder/);

    assert.deepEqual(supersede(), { ok: true, changed: true });
    assert.equal(sql('SELECT final_pdf_path || \' \' || final_pdf_hash FROM sales_agreement_envelope'), `${newPath} ${newHash}`);
    assert.equal(sql('SELECT superseded_path || \' \' || superseded_hash || \' \' || layout FROM sales_agreement_final_pdf_history'), `${oldPath} ${oldHash} proposal-layout-v2`);
    assert.equal(evidence(), before, 'signed evidence unchanged');
    // Rerun is a no-op.
    assert.deepEqual(supersede(), { ok: true, changed: false });
    assert.equal(sql('SELECT count(*) FROM sales_agreement_final_pdf_history'), '1');
    // History is append-only; other envelope fields remain immutable.
    assert.throws(() => sql('DELETE FROM sales_agreement_final_pdf_history'), /append-only/);
    assert.throws(() => sql("UPDATE sales_agreement_final_pdf_history SET layout='x'"), /append-only/);
    assert.throws(() => sql("UPDATE sales_agreement_envelope SET customer='{}'"), /immutable/);
    assert.throws(() => sql("UPDATE sales_agreement_envelope SET finalization_error='x'"), /immutable/);
    assert.throws(() => sql('DELETE FROM sales_agreement_envelope'), /cannot be deleted/);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
