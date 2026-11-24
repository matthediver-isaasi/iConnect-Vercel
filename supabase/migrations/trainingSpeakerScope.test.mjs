import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const migrations = [
  '20260804_speaker_awards.sql','20261011_speaker_award_assignment_reconciliation.sql',
  '20261124_speaker_recognition.sql','20261124_speaker_recognition_history.sql',
  '202701220001_training_speaker_scope.sql','202701220002_training_speaker_processing.sql',
  '202701220003_training_speaker_lifecycle.sql','202701220004_training_speaker_atomic_save.sql',
  '202701220005_training_speaker_consumers.sql','202701220006_training_speaker_deletion.sql',
];
async function fixture(t, arrayType, rolloutControls = false) {
  const root = await mkdtemp(join(tmpdir(),'training-speaker-scope-'));
  execFileSync('initdb',['-D',join(root,'data'),'-A','trust','-U','postgres'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',join(root,'data'),'-o',`-F -k ${root} -c listen_addresses=''`,'-w','start'],{stdio:'ignore'});
  const clients = [];
  const connect = async () => {
    const c = new pg.Client({host:root,user:'postgres',database:'postgres'});
    await c.connect(); clients.push(c); return c;
  };
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    execFileSync('pg_ctl',['-D',join(root,'data'),'-m','immediate','stop'],{stdio:'ignore'});
    await rm(root,{recursive:true,force:true});
  });
  const c=await connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text);
    CREATE TABLE tenant(id uuid PRIMARY KEY);
    CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text);
    CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,email text);
    CREATE TABLE speaker(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,full_name text,email text,organization text);
    CREATE TABLE badge(id uuid PRIMARY KEY,tenant_id uuid,name text,image_url text);
    CREATE TABLE cpd_certificate_template(id uuid PRIMARY KEY,tenant_id uuid,status text,source_path text,source_bucket text,source_sha256 text);
    CREATE TABLE cpd_certificate_placeholder(id uuid PRIMARY KEY,tenant_id uuid,template_id uuid,page_number int,display_order int,placeholder_key text);
    CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,title text,start_date timestamptz,end_date timestamptz,
      timezone text,status text,event_state text,speaker_ids ${arrayType},is_training boolean DEFAULT false,updated_at timestamptz,zoom_webinar_id uuid,
      available_seats integer DEFAULT 100,search_text text);
    CREATE TABLE complex_event(LIKE event INCLUDING ALL);
    CREATE TABLE event_agenda_item(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,event_id uuid,
      start_date date,end_date date,start_time time,end_time time,description text,
      speaker_ids ${arrayType},sort_order int DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz,zoom_webinar_id uuid);
    CREATE TABLE complex_event_session(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,speaker_ids ${arrayType},zoom_webinar_id text);
    CREATE TABLE zoom_webinar(id uuid PRIMARY KEY,tenant_id uuid,zoom_webinar_id text);
    CREATE TABLE voucher(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid,code text UNIQUE,
      value numeric,description text,expires_at timestamptz,issued_at timestamptz,status text,funding_source text,created_by text);
  `);
  await c.query(await readFile(new URL('./20260804_speaker_awards.sql',import.meta.url),'utf8'));
  await c.query(`ALTER TABLE member_badge ADD COLUMN revoked_at timestamptz,ADD COLUMN revoked_by_type text,
    ADD COLUMN revoked_by_id uuid,ADD COLUMN revoked_by_label text,ADD COLUMN awarded_by_type text,ADD COLUMN awarded_by_label text;
    ALTER TABLE member_badge DROP CONSTRAINT member_badge_badge_id_member_id_key;
    CREATE UNIQUE INDEX member_badge_active ON member_badge(badge_id,member_id) WHERE revoked_at IS NULL;`);
  await c.query('ALTER TABLE speaker_award_grant ADD COLUMN notified_at timestamptz');
  for (const file of migrations.slice(1)) {
    if (rolloutControls && file === '202701220001_training_speaker_scope.sql') {
      await c.query(await readFile(new URL('./202701230001_training_speaker_rollout_control.sql',import.meta.url),'utf8'));
      await c.query(`SELECT set_speaker_rollout_phase('draining',0,'isolated fixture coverage verified');
        SELECT set_speaker_rollout_phase('paused',1,'isolated fixture drain verified');`);
    }
    await c.query(await readFile(new URL(`./${file}`,import.meta.url),'utf8'));
  }
  if (rolloutControls) await c.query(`SELECT set_speaker_rollout_phase('open',2,'isolated fixture schema installed')`);
  await c.query(`INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
    INSERT INTO organization VALUES('${id(3)}','${id(1)}','Organisation');
    INSERT INTO member VALUES('${id(4)}','${id(1)}','${id(3)}','speaker@example.test');
    INSERT INTO speaker VALUES('${id(5)}','${id(1)}','${id(4)}','Speaker','speaker@example.test','Organisation');
    INSERT INTO speaker VALUES('${id(8)}','${id(1)}',NULL,'Unallocated','external@example.test','Organisation');
    INSERT INTO badge VALUES('${id(6)}','${id(1)}','Speaker badge',NULL);
    INSERT INTO cpd_certificate_template VALUES('${id(7)}','${id(1)}','active','${id(1)}/source.pdf','private-uploads','${'a'.repeat(64)}');`);
  const refs = values => arrayType==='jsonb' ? JSON.stringify(values) : values;
  const cfg = value => ({enabled:true,badge_timing:'on_assignment',default:{badge_id:id(6),voucher_value:value,voucher_expiry:'2032-01-01',certificate_template_id:id(7)},overrides:{}});
  return {c,connect,refs,cfg};
}

test('the six feature migrations install while separate rollout controls are paused', async t => {
  const { c } = await fixture(t, 'uuid[]', true);
  assert.equal((await c.query('SELECT phase FROM speaker_rollout_control')).rows[0].phase, 'open');
  assert.equal((await c.query('SELECT count(*)::int n FROM training_speaker_scope_policy')).rows[0].n, 1);
});

for (const type of ['uuid[]','jsonb']) test(`scoped training identities, transactions and provenance (${type})`,async t => {
  const {c,connect,refs,cfg}=await fixture(t,type);
  await c.query(`UPDATE training_speaker_scope_policy SET starts_at=now()-interval '2 days'`);
  await c.query(`INSERT INTO event(id,tenant_id,title,start_date,timezone,status,is_training,speaker_ids)
    VALUES('${id(10)}','${id(1)}','Training',now()-interval '1 day','Europe/London','published',true,$1)`,[refs([])]);
  // Legacy assignments are retained only when they predate training conversion.
  await c.query(`UPDATE event SET is_training=false WHERE id='${id(10)}'`);
  await c.query(`UPDATE event SET speaker_ids=$1 WHERE id='${id(10)}'`,[refs([id(5),id(8)])]);
  await c.query(`INSERT INTO speaker_recognition(id,tenant_id,event_type,event_id,speaker_id,status,certificate_status,snapshot,pdf_path,pdf_sha256,issued_at)
    VALUES('${id(30)}','${id(1)}','event','${id(10)}','${id(8)}','active','issued','{"event_title":"Historical"}',
      '${id(1)}/${id(30)}.pdf','${'b'.repeat(64)}',now())`);
  await c.query(`UPDATE event SET is_training=true WHERE id='${id(10)}'`);
  for (const [line,date,value] of [[11,-1,10],[12,1,20]]) {
    await c.query(`INSERT INTO event_agenda_item(id,tenant_id,event_id,start_date,description,speaker_ids,speaker_award_config,sort_order)
      VALUES($1,$2,$3,(now()+($4||' day')::interval)::date,$5,$6,$7,$8)`,
    [id(line),id(1),id(10),date,`Line ${line}`,refs([id(5)]),cfg(value),line]);
  }
  await c.query('SELECT reconcile_training_speaker_scope($1,$2)',[id(1),id(10)]);
  await c.query(`UPDATE event SET available_seats=available_seats-1 WHERE id='${id(10)}';
    UPDATE event SET available_seats=available_seats+1 WHERE id='${id(10)}';
    UPDATE event SET search_text='asynchronously indexed title',updated_at=now() WHERE id='${id(10)}';`);
  assert.equal((await c.query(`SELECT speaker_scope_ready FROM event WHERE id='${id(10)}'`)).rows[0].speaker_scope_ready,true,
    'Bookings, cancellations and search updates must preserve finalized future appearances');
  const other=await connect();
  await Promise.all([c,other].map(db=>db.query('SELECT process_training_speaker_awards($1,$2,true)',[id(1),id(10)])));
  assert.equal((await c.query('SELECT count(*)::int n FROM member_badge')).rows[0].n,1);
  assert.equal((await c.query('SELECT count(*)::int n FROM speaker_award_grant')).rows[0].n,2);
  await c.query('SELECT process_training_speaker_awards($1,$2,false)',[id(1),id(10)]);
  assert.equal((await c.query('SELECT value FROM voucher')).rows[0].value,'10');
  await c.query('SELECT sync_speaker_recognition($1,$2,$3)',[id(1),'event',id(10)]);
  let rows=(await c.query('SELECT * FROM speaker_recognition WHERE agenda_item_id IS NOT NULL ORDER BY agenda_item_id')).rows;
  assert.equal(rows.length,2);
  assert.equal(rows[0].certificate_status,'pending');
  assert.equal(rows[1].certificate_status,'unavailable');
  assert.equal(rows[0].snapshot.agenda_description,'Line 11');
  assert.equal(rows[0].snapshot.event_title,'Training');
  const first=rows[0];
  await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4)',[id(1),first.id,`${id(1)}/${first.id}.pdf`,'a'.repeat(64)]);
  // Later appearances are not suppressed by the first line or parent marker.
  await c.query(`UPDATE event SET speaker_awards_granted_at=now(),speaker_recognition_processed_at=now() WHERE id='${id(10)}';
    UPDATE event_agenda_item SET start_date=(now()-interval '1 hour')::date WHERE id='${id(12)}';
    SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}');
    SELECT process_training_speaker_awards('${id(1)}','${id(10)}',false);
    SELECT sync_speaker_recognition('${id(1)}','event','${id(10)}');`);
  assert.deepEqual((await c.query('SELECT value FROM voucher ORDER BY value')).rows.map(r=>r.value),['10','20']);
  rows=(await c.query('SELECT * FROM speaker_recognition WHERE agenda_item_id IS NOT NULL ORDER BY agenda_item_id')).rows;
  assert.equal(rows[1].certificate_status,'pending');
  assert.equal(rows[0].pdf_sha256,'a'.repeat(64));
  const secondRecognition=rows[1];
  await c.query(`UPDATE event_agenda_item SET start_date=(now()+interval '1 day')::date WHERE id='${id(12)}';
    SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}');`);
  assert.equal((await c.query('SELECT finish_speaker_certificate($1,$2,$3,$4) issued',
    [id(1),secondRecognition.id,`${id(1)}/${secondRecognition.id}.pdf`,'c'.repeat(64)])).rows[0].issued,false);
  await c.query(`UPDATE event_agenda_item SET start_date=(now()-interval '1 hour')::date WHERE id='${id(12)}';
    SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}');`);
  assert.equal((await c.query(`SELECT training_speaker_ids('${id(1)}','${id(10)}') ids`)).rows[0].ids.includes(id(8)),false);
  await c.query(`UPDATE event SET speaker_ids=$1 WHERE id='${id(10)}'`,[refs([id(8)])]);
  await assert.rejects(c.query(`UPDATE event SET speaker_ids=$1 WHERE id='${id(10)}'`,[refs([])]),/needs allocation/);
  const historical=(await c.query(`SELECT status,pdf_sha256,snapshot FROM speaker_recognition WHERE id='${id(30)}'`)).rows[0];
  assert.equal(historical.status,'active');
  assert.equal(historical.pdf_sha256,'b'.repeat(64));
  assert.deepEqual(historical.snapshot,{event_title:'Historical'});
  await assert.rejects(c.query(`UPDATE event_agenda_item SET event_id='${id(99)}' WHERE id='${id(11)}'`),/immutable/);
  await assert.rejects(c.query(`INSERT INTO speaker_award_grant(tenant_id,event_type,event_id,speaker_id,status)
    VALUES('${id(1)}','event','${id(10)}','${id(5)}','pending')`),/Event-wide/);
  await assert.rejects(c.query(`SELECT speaker_agenda_instant('2027-03-28','01:30','Europe/London')`),/ambiguous|does not exist/);
  await assert.rejects(c.query(`SELECT speaker_agenda_instant('2027-10-31','01:30','Europe/London')`),/ambiguous|does not exist/);
  // Removing one entitlement cannot revoke the shared credential.
  await c.query(`DELETE FROM event_agenda_item WHERE id='${id(11)}';
    SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}',true);`);
  assert.equal((await c.query('SELECT revoked_at FROM member_badge')).rows[0].revoked_at,null);
  assert.equal((await c.query('SELECT status FROM speaker_recognition WHERE id=$1',[first.id])).rows[0].status,'revoked');
  // Permissions are verified as the actual database roles, not inferred.
  await c.query('SET ROLE authenticated');
  await assert.rejects(c.query(`SELECT process_training_speaker_awards('${id(1)}','${id(10)}',false)`),/permission denied/);
  await c.query('RESET ROLE');
  const before=(await c.query(`SELECT title FROM event WHERE id='${id(10)}'`)).rows[0].title;
  await assert.rejects(c.query('SELECT save_training_event_agenda($1,$2,$3,$4)',[id(1),id(10),{title:'Must roll back'},JSON.stringify([
    {id:id(12),start_date:'2027-01-01',speaker_ids:[id(999)]},
  ])]),/speaker does not belong/);
  assert.equal((await c.query(`SELECT title FROM event WHERE id='${id(10)}'`)).rows[0].title,before);
  await c.query(`UPDATE event_agenda_item SET speaker_award_config=jsonb_set(speaker_award_config,'{default,voucher_value}','25') WHERE id='${id(12)}'`);
  assert.equal((await c.query(`SELECT speaker_scope_ready FROM event WHERE id='${id(10)}'`)).rows[0].speaker_scope_ready,false,
    'Genuine line award configuration changes still invalidate readiness');
  await c.query(`SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}')`);
  assert.equal((await c.query(`SELECT speaker_agenda_instant('2027-07-01',NULL,'Europe/London') start`)).rows[0].start.toISOString(),'2027-06-30T23:00:00.000Z');
  // Failure on one appearance rolls back only that appearance's effects.
  for (const [line,value] of [[13,30],[14,40]]) {
    await c.query(`INSERT INTO event_agenda_item(id,tenant_id,event_id,start_date,speaker_ids,speaker_award_config,sort_order)
      VALUES($1,$2,$3,now()::date,$4,$5,$6)`,[id(line),id(1),id(10),refs([id(5)]),cfg(value),line]);
  }
  await c.query(`CREATE FUNCTION reject_fixture_voucher() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.value=30 THEN RAISE EXCEPTION 'Fixture provider failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_fixture_voucher BEFORE INSERT ON voucher FOR EACH ROW EXECUTE FUNCTION reject_fixture_voucher();
    SELECT reconcile_training_speaker_scope('${id(1)}','${id(10)}');
    SELECT process_training_speaker_awards('${id(1)}','${id(10)}',false);`);
  assert.equal((await c.query('SELECT count(*)::int n FROM voucher WHERE value=40')).rows[0].n,1);
  assert.match((await c.query(`SELECT speaker_awards_error FROM event_agenda_item WHERE id='${id(13)}'`)).rows[0].speaker_awards_error,/Fixture/);
  await c.query(`DROP TRIGGER reject_fixture_voucher ON voucher;
    SELECT process_training_speaker_awards('${id(1)}','${id(10)}',false);`);
  assert.equal((await c.query('SELECT count(*)::int n FROM voucher WHERE value=30')).rows[0].n,1);
  assert.equal((await c.query('SELECT count(*)::int n FROM voucher WHERE value=40')).rows[0].n,1);
  // Ordinary and complex events retain their original recognition identity.
  await c.query(`UPDATE speaker_recognition_policy SET starts_at=now()-interval '2 days'`);
  for (const [table,num] of [['event',50],['complex_event',51]]) {
    await c.query(`INSERT INTO ${table}(id,tenant_id,title,start_date,timezone,status,speaker_ids,is_training,speaker_award_config)
      VALUES($1,$2,'Ordinary',now()-interval '1 hour','Europe/London','published',$3,false,$4)`,
    [id(num),id(1),refs([id(5)]),cfg(10)]);
    if (table==='complex_event') await c.query('INSERT INTO complex_event_session(id,tenant_id,complex_event_id,speaker_ids) VALUES($1,$2,$3,$4)',
      [id(52),id(1),id(num),refs([id(5)])]);
    await c.query('SELECT sync_speaker_recognition($1,$2,$3)',[id(1),table,id(num)]);
    const ordinary=(await c.query('SELECT agenda_item_id,certificate_status FROM speaker_recognition WHERE event_id=$1',[id(num)])).rows;
    assert.equal(ordinary.length,1);
    assert.equal(ordinary[0].agenda_item_id,null);
    assert.equal(ordinary[0].certificate_status,'pending');
  }
  // Successful atomic saves retain existing line identities and add fresh IDs.
  const saved=(await c.query('SELECT save_training_event_agenda($1,$2,$3,$4) doc',[id(1),id(10),{title:'Saved training'},JSON.stringify([
    {id:id(12),start_date:'2027-01-01',speaker_ids:[id(5)],sort_order:0},
    {start_date:'2027-01-02',speaker_ids:[id(5)],description:'New line',sort_order:1},
  ])])).rows[0].doc;
  assert.equal(saved.title,'Saved training');
  assert.equal(saved._training_agenda_lines[0].id,id(12));
  assert.notEqual(saved._training_agenda_lines[1].id,id(12));
  assert.equal((await c.query(`SELECT speaker_scope_ready FROM event WHERE id='${id(10)}'`)).rows[0].speaker_scope_ready,false);
  await c.query(`INSERT INTO zoom_webinar VALUES('${id(40)}','${id(1)}','provider');
    UPDATE event SET zoom_webinar_id='${id(40)}' WHERE id='${id(10)}';`);
  const desired=(await c.query(`SELECT zoom_speaker_desired('${id(1)}','${id(40)}') desired`)).rows[0].desired;
  assert.deepEqual(desired.map(s=>s.id),[id(5)]);
  // A removed speaker is pruned from every agenda row, even outside the API.
  await c.query(`DELETE FROM speaker WHERE id='${id(5)}'`);
  assert.equal((await c.query(`SELECT count(*)::int n FROM event_agenda_item WHERE to_jsonb(speaker_ids) ? '${id(5)}'`)).rows[0].n,0);
});
