// Isolated PostgreSQL only. Never consumes application database credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const root = await mkdtemp(join(tmpdir(), 'mandate-replacement-pg-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const data = join(root, 'data');
let started = false;
let db;
try {
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-U', 'postgres'], { stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-F -h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  await db.connect();
  await db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE membership_billing_agreements(
      id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, organization_id uuid,
      provider text, agreement_type text, environment text,
      gocardless_mandate_id text, gocardless_customer_id text);
    CREATE TABLE member_membership_history(
      id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, billing_agreement_id uuid);
    CREATE TABLE membership_payment_plans(
      id uuid PRIMARY KEY, tenant_id uuid, billing_agreement_id uuid,
      gocardless_mandate_id text, gocardless_subscription_id text, environment text);
    CREATE TABLE gocardless_collection_reservations(
      id uuid PRIMARY KEY, billing_agreement_id uuid,status text,gocardless_payment_id text);
  `);
  await db.query(await readFile(new URL('../supabase/migrations/202611030001_gocardless_mandate_replacement.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/202611030002_gocardless_mandate_handover.sql', import.meta.url), 'utf8'));
  const tenant = randomUUID(), member = randomUUID(), agreement = randomUUID(), history = randomUUID();
  await db.query("INSERT INTO membership_billing_agreements VALUES ($1,$2,$3,null,'gocardless','member','live','old','customer')", [agreement, tenant, member]);
  await db.query('INSERT INTO member_membership_history VALUES ($1,$2,$3,$4)', [history, tenant, member, agreement]);
  const insert = `INSERT INTO membership_mandate_replacements
    (tenant_id,member_id,agreement_id,history_id,environment,provider_context,old_mandate_id,old_customer_id)
    VALUES ($1,$2,$3,$4,'live','{}','old','customer') RETURNING *`;
  await assert.rejects(db.query(insert, [tenant, randomUUID(), agreement, history]), /ownership mismatch/);
  const op = (await db.query(insert, [tenant, member, agreement, history])).rows[0];
  await assert.rejects(db.query(insert, [tenant, member, agreement, history]), /unique constraint/);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET old_mandate_id='other' WHERE id=$1", [op.id]), /origin is immutable/);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET status='completed' WHERE id=$1", [op.id]), /Verified retirement/);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET new_mandate_id='old' WHERE id=$1", [op.id]), /must be distinct/);
  await db.query("UPDATE membership_mandate_replacements SET billing_request_id='request',flow_id='flow',new_mandate_id='new' WHERE id=$1", [op.id]);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET billing_request_id='another' WHERE id=$1", [op.id]), /provider identity is immutable/);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET new_mandate_id=null WHERE id=$1", [op.id]), /provider identity is immutable/);
  await db.query("UPDATE membership_mandate_replacements SET status='action_required' WHERE id=$1", [op.id]);
  await assert.rejects(db.query("UPDATE membership_mandate_replacements SET status='authorizing' WHERE id=$1", [op.id]), /reviewed resolution/);
  for (const role of ['anon', 'authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM membership_mandate_replacements'), /permission denied/);
    await assert.rejects(db.query(insert, [tenant, member, agreement, history]), /permission denied/);
    await db.query('RESET ROLE');
  }
  // Candidate storage has not rebound any existing collection identity.
  assert.equal((await db.query('SELECT gocardless_mandate_id FROM membership_billing_agreements')).rows[0].gocardless_mandate_id, 'old');
  const intent = (await db.query("SELECT begin_gocardless_mutation('live','old','request-key',null) id")).rows[0].id;
  await db.query('SELECT finish_gocardless_mutation($1,false)', [intent]);
  assert.equal((await db.query('SELECT state FROM gocardless_mutation_intents WHERE id=$1', [intent])).rows[0].state, 'unknown');
  await db.query('SELECT finish_gocardless_mutation($1,true)', [intent]);
  assert.equal((await db.query('SELECT state FROM gocardless_mutation_intents WHERE id=$1', [intent])).rows[0].state, 'confirmed');
  await db.query("SELECT begin_gocardless_mutation('live','old','request-key',null)");
  assert.equal((await db.query('SELECT state FROM gocardless_mutation_intents WHERE id=$1', [intent])).rows[0].state, 'pending');
  await assert.rejects(db.query("SELECT begin_gocardless_mutation('live','old','wrong-owner',$1)", [op.id]), /Invalid handover/);
  await db.query('SET ROLE authenticated');
  await assert.rejects(db.query("SELECT begin_gocardless_mutation('live','old','forbidden',null)"), /permission denied/);
  await db.query('RESET ROLE');
  // A second isolated owner exercises the annual identity-only commit.
  const agreement2 = randomUUID(), history2 = randomUUID(), member2 = randomUUID();
  await db.query("INSERT INTO membership_billing_agreements VALUES ($1,$2,$3,null,'gocardless','member','live','old2','customer2')", [agreement2,tenant,member2]);
  await db.query('INSERT INTO member_membership_history VALUES ($1,$2,$3,$4)', [history2,tenant,member2,agreement2]);
  let handover = (await db.query(`INSERT INTO membership_mandate_replacements
    (tenant_id,member_id,agreement_id,history_id,environment,provider_context,old_mandate_id,old_customer_id)
    VALUES($1,$2,$3,$4,'live','{}','old2','customer2') RETURNING *`,[tenant,member2,agreement2,history2])).rows[0];
  handover = (await db.query("UPDATE membership_mandate_replacements SET new_mandate_id='new2',new_customer_id='customer-new2' WHERE id=$1 RETURNING *",[handover.id])).rows[0];
  const snapshot = {
    agreement:(await db.query('SELECT to_jsonb(a) a FROM membership_billing_agreements a WHERE id=$1',[agreement2])).rows[0].a,
    history:(await db.query('SELECT to_jsonb(h) h FROM member_membership_history h WHERE id=$1',[history2])).rows[0].h,
    plan:null, mode:'annual', payments:[],
  };
  await assert.rejects(db.query('SELECT prepare_mandate_handover($1,$2,$3)',[handover.id,handover.version,snapshot]), /release evidence/);
  await db.query("INSERT INTO gocardless_replacement_release VALUES('live',true,'isolated-test-evidence',now()-interval '10 minutes')");
  handover = (await db.query('SELECT * FROM prepare_mandate_handover($1,$2,$3)',[handover.id,handover.version,snapshot])).rows[0];
  await assert.rejects(db.query("SELECT begin_gocardless_mutation('live','old2','concurrent',null)"), /handover owns/);
  await assert.rejects(db.query("UPDATE membership_billing_agreements SET gocardless_mandate_id='foreign' WHERE id=$1",[agreement2]), /fences/);
  await db.query("UPDATE membership_mandate_replacements SET phase='commit_intent' WHERE id=$1",[handover.id]);
  handover = (await db.query('SELECT * FROM membership_mandate_replacements WHERE id=$1',[handover.id])).rows[0];
  await db.query('SELECT commit_mandate_handover($1,$2)',[handover.id,handover.version]);
  const changed = (await db.query('SELECT to_jsonb(a) a FROM membership_billing_agreements a WHERE id=$1',[agreement2])).rows[0].a;
  assert.deepEqual(changed,{...snapshot.agreement,gocardless_mandate_id:'new2',gocardless_customer_id:'customer-new2'});
  assert.deepEqual((await db.query('SELECT to_jsonb(h) h FROM member_membership_history h WHERE id=$1',[history2])).rows[0].h,snapshot.history);
  console.log('Replacement SQL checks passed: ownership, uniqueness, immutable identities, release gate, RLS, original preservation.');
} finally {
  await db?.end();
  if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  await rm(root, { recursive: true, force: true });
}
