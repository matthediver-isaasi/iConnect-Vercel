import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('disposable PostgreSQL: proof-bound atomic acceptance, durable OTP bounds, immutable evidence and private grants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agreement-sql-'));
  const data = join(dir, 'db'), socket = join(dir, 'socket');
  mkdirSync(socket);
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Command failed');
    return result.stdout.trim();
  };
  const sql = query => run('psql', ['-h', socket, '-p', '55462', '-U', 'postgres', '-d', 'postgres', '-qXAt', '-v', 'ON_ERROR_STOP=1'], query);
  const service = query => sql(`SET ROLE service_role; SET request.jwt.claim.role='service_role'; ${query}`).split('\n').at(-1);
  const tenant = '00000000-0000-0000-0000-000000000001';
  const quote = '00000000-0000-0000-0000-000000000002';
  const version = '00000000-0000-0000-0000-000000000003';
  const token = '00000000-0000-0000-0000-000000000004';
  const digest = 'a'.repeat(64), code = 'b'.repeat(64), proof = 'c'.repeat(64);
  const otp = (action, hash = code, session = proof) => service(`SELECT sales_agreement_otp('${token}','${action}','${hash}','${session}')`);
  const decide = (session, fail = false) => service(`${fail ? "SET agreement.fail='yes';" : ''} SELECT decide_sales_quote_public('${digest}','accepted','Buyer','Director',NULL,NULL,NULL,true,'once',
    '${JSON.stringify({ agreementEvidence: { consent: true, signature: { mode: 'drawn', data: 'data:image/png;base64,AAAA' },
      ...(session ? { verificationProofHash: session } : {}) } })}'::jsonb)`);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-F -k ${socket} -p 55462 -c listen_addresses=''`, '-w', 'start']);
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
      CREATE TABLE allocations(id integer);
      CREATE FUNCTION confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('agreement.fail',true)='yes' THEN RAISE EXCEPTION 'capacity conflict' USING ERRCODE='23514'; END IF;
          INSERT INTO allocations VALUES(1); RETURN '{}'::jsonb;
        END $$;
      INSERT INTO sales_quote VALUES('${quote}','${tenant}',1,1,now(),'actor');
      INSERT INTO sales_quote_version VALUES('${version}','${tenant}','${quote}',1,'sent','{"legalHtml":"<p>Terms</p>"}',now(),now()+interval '30 days');
      INSERT INTO sales_quote_delivery_token VALUES('${token}','${tenant}','${quote}','${version}',decode('${digest}','hex'),'buyer@example.org',now(),NULL,now()+interval '1 day');
    `);
    sql(readFileSync('supabase/migrations/202610190001_sales_agreements.sql', 'utf8'));
    const delivery = readFileSync('supabase/migrations/20260911_sales_quote_delivery.sql', 'utf8');
    const start = delivery.indexOf('CREATE OR REPLACE FUNCTION public.decide_sales_quote_public(');
    sql(delivery.slice(start, delivery.indexOf('END $$;', start) + 'END $$;'.length));
    sql('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role');
    const request = () => service(`SELECT request_sales_agreement_signature('${tenant}','${quote}','${version}',
      'requester','tenant_user','actor','tenant_user','Actor','actor@example.org','{"personalMessage":"Review this"}')`);
    assert.equal(JSON.parse(request()).status, 'pending');
    assert.throws(request, /rate limit/);
    assert.equal(sql('SELECT count(*) FROM sales_agreement_envelope'), '0');
    sql(`INSERT INTO sales_agreement_envelope(tenant_id,quote_id,quote_version_id,sender_actor_id,sender_actor_type,sender,contact,sender_consent,sender_evidence,snapshot,document_hash)
      VALUES('${tenant}','${quote}','${version}','actor','tenant_user','{"email":"seller@example.org"}','{"email":"buyer@example.org"}',true,'{}',
      '{"version":{"id":"${version}","terms_snapshot":{"legalHtml":"<p>Terms</p>"}}}','${digest}');`);
    assert.equal(sql('SELECT status FROM sales_agreement_signing_request'), 'signed');
    assert.throws(() => sql(`UPDATE sales_quote_version SET status='accepted' WHERE id='${version}'`), /verified customer/);
    assert.equal(JSON.parse(otp('send')).ok, true);
    assert.equal(JSON.parse(otp('send')).ok, false);
    for (let i = 0; i < 5; i++) assert.equal(JSON.parse(otp('verify', 'd'.repeat(64))).ok, false);
    assert.equal(JSON.parse(otp('verify')).ok, false);
    sql("UPDATE sales_agreement_verification SET sent_at=now()-interval '2 minutes'");
    assert.equal(JSON.parse(otp('send')).ok, true);
    assert.equal(JSON.parse(otp('verify')).ok, true);
    assert.throws(() => decide(), /Verified recipient/);
    assert.throws(() => decide('e'.repeat(64)), /Verified recipient/);
    assert.equal(sql('SELECT count(*) FROM allocations'), '0');
    assert.equal(sql('SELECT count(*) FROM sales_quote_customer_decision'), '0');
    sql("UPDATE sales_agreement_verification SET sent_at=now()-interval '2 minutes'");
    assert.equal(JSON.parse(otp('send')).ok, true);
    assert.throws(() => decide(proof), /Verified recipient/); // resend invalidates proof
    assert.equal(JSON.parse(otp('verify')).ok, true);
    assert.throws(() => decide(proof, true), /capacity conflict/);
    assert.equal(sql('SELECT count(*) FROM sales_quote_customer_decision'), '0');
    assert.equal(sql('SELECT customer IS NULL FROM sales_agreement_envelope'), 't');
    assert.equal(sql('SELECT status FROM sales_quote_version'), 'sent');
    assert.equal(JSON.parse(decide(proof)).outcome, 'accepted');
    assert.equal(JSON.parse(decide(proof)).idempotent, true);
    assert.equal(sql('SELECT count(*) FROM allocations'), '1');
    assert.equal(sql('SELECT count(*) FROM sales_quote_customer_decision'), '1');
    const envelopeId = sql('SELECT id FROM sales_agreement_envelope');
    const notice = party => service(`SELECT claim_sales_agreement_completion_notice('${envelopeId}','${party}')`);
    assert.equal(notice('sender'), '');
    sql(`UPDATE sales_agreement_envelope SET finalization_status='complete',final_pdf_path='private.pdf',final_pdf_hash='${digest}',finalized_at=now()`);
    assert.equal(JSON.parse(notice('sender')).recipient_email, 'seller@example.org');
    assert.equal(notice('sender'), '');
    assert.equal(JSON.parse(notice('customer')).recipient_email, 'buyer@example.org');
    sql("UPDATE sales_agreement_completion_notice SET status='sent',lease_until=NULL");
    assert.equal(notice('sender'), '');
    assert.throws(() => sql("UPDATE sales_agreement_envelope SET final_pdf_path='replacement.pdf'"), /immutable/);
    assert.throws(() => sql("UPDATE sales_agreement_envelope SET customer='{}'"), /immutable/);
    assert.throws(() => sql("UPDATE sales_agreement_envelope SET sender='{\"name\":\"Other\"}'"), /immutable/);
    assert.throws(() => sql('DELETE FROM sales_agreement_envelope'), /cannot be deleted/);
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`SET ROLE ${role}; SELECT * FROM sales_agreement_envelope`), /permission denied/);
      assert.throws(() => sql(`SET ROLE ${role}; SELECT sales_agreement_otp('${token}','send','${code}',NULL)`), /permission denied/);
    }
    assert.equal(sql("SELECT public FROM storage.buckets WHERE id='sales-agreements'"), 'f');
    assert.equal(sql("SELECT polpermissive FROM pg_policy WHERE polname='sales_agreements_private'"), 'f');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
