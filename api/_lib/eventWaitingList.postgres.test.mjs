import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('waiting list storage: isolation, idempotency, atomicity, withdrawal and booking separation', () => {
  const root=mkdtempSync(path.join(tmpdir(),'waiting-list-pg-'));
  const data=path.join(root,'data'), socket=path.join(root,'socket'); mkdirSync(socket);
  const run=(cmd,args,input,ok=true)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    if(ok) assert.equal(r.status,0,r.stderr); else assert.notEqual(r.status,0,'Expected rejection');
    return r.stdout.trim();
  };
  const sql=(q,ok=true)=>run('psql',['-h',socket,'-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],q,ok);
  const tenant='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
  const member='20000000-0000-4000-8000-000000000001', colleague='20000000-0000-4000-8000-000000000002';
  const event='30000000-0000-4000-8000-000000000001', complex='30000000-0000-4000-8000-000000000002';
  const key='40000000-0000-4000-8000-000000000001';
  let started=false;
  try {
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o',`-F -k ${socket} -c listen_addresses=`,'-w','start']); started=true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,title text,status text,event_state text,registration_closes_at timestamptz);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE booking(id uuid DEFAULT gen_random_uuid(),event_id uuid,status text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      INSERT INTO member VALUES('${member}','${tenant}','one@example.invalid'),('${colleague}','${tenant}','two@example.invalid');
      INSERT INTO event VALUES('${event}','${tenant}','Interest','published','active',null);
      INSERT INTO complex_event VALUES('${complex}','${tenant}','Sessions','tbc','active',null);
      INSERT INTO booking(event_id,status) VALUES('${event}','confirmed');`);
    sql(readFileSync(new URL('../../supabase/migrations/20261205_event_waiting_lists.sql',import.meta.url),'utf8'));
    const entries=[{member_id:member,first_name:'One',last_name:'Person',email:'one@example.invalid',ticket_name:'Standard',advertised_price:120,currency:'gbp',session_ids:[]},
      {member_id:colleague,first_name:'Two',last_name:'Person',email:'two@example.invalid',ticket_name:'Standard',advertised_price:120,currency:'gbp'}];
    const create=(ev=event,kind='simple',keyValue=key,hash='hash',payload=entries,tenantValue=tenant)=>`SELECT create_event_waiting_registration('${tenantValue}','${member}','${ev}','${kind}','${keyValue}','${hash}','${JSON.stringify(payload)}');`;
    sql(create(),false);
    sql(`UPDATE event SET waiting_list_enabled=true; UPDATE complex_event SET waiting_list_enabled=true;`);
    const id=sql(create());
    assert.equal(sql(create()),id,'retry returns original');
    sql(create(event,'simple',key,'different'),false);
    assert.equal(sql('SELECT count(*) FROM event_waiting_entry;'),'2');
    assert.equal(sql('SELECT count(*) FROM booking;'),'1','existing booking preserved');
    sql(`INSERT INTO booking(event_id,status) VALUES('${event}','confirmed');`,false);
    sql(`UPDATE booking SET status='cancelled';`);
    sql(create(complex,'complex','40000000-0000-4000-8000-000000000002'));
    sql(create(event,'simple','40000000-0000-4000-8000-000000000003'),false);
    sql(create(event,'simple','40000000-0000-4000-8000-000000000004','hash',entries,other),false);
    const first=sql(`SELECT id FROM event_waiting_entry WHERE registration_id='${id}' AND member_id='${member}';`);
    const second=sql(`SELECT id FROM event_waiting_entry WHERE registration_id='${id}' AND member_id='${colleague}';`);
    sql(`SELECT withdraw_event_waiting_entry('${tenant}','${colleague}','${first}','attendee');`,false);
    sql(`SELECT withdraw_event_waiting_entry('${tenant}','${colleague}','${second}','registration');`,false);
    assert.equal(sql(`SELECT withdraw_event_waiting_entry('${tenant}','${colleague}','${second}','attendee');`),'1');
    assert.equal(sql(`SELECT status FROM event_waiting_entry WHERE id='${first}';`),'active','colleague cannot remove booker');
    assert.equal(sql(`SELECT withdraw_event_waiting_entry('${tenant}','${member}','${first}','registration');`),'1');
    assert.equal(sql(`SELECT withdraw_event_waiting_entry('${tenant}','${member}','${first}','registration');`),'0','withdrawal replay safe');
    sql(`SET ROLE authenticated; SELECT * FROM event_waiting_entry;`,false);
    sql(`SET ROLE anon; ${create()}`,false);
    sql(`SET ROLE authenticated; SELECT withdraw_event_waiting_entry('${tenant}','${member}','${first}','registration');`,false);
    sql(`SET ROLE service_role; SELECT * FROM event_waiting_entry;`);
    sql(`UPDATE event SET waiting_list_enabled=false; INSERT INTO booking(event_id,status) VALUES('${event}','confirmed');`);
    sql(create(event,'simple','40000000-0000-4000-8000-000000000005'),false);
    assert.equal(sql(`SELECT count(*) FROM event_waiting_registration;`),'2','failed creates are atomic');
    // Guest imports retain source booking evidence without inventing a member.
    sql(`ALTER TABLE event ADD COLUMN pricing_config jsonb;
      ALTER TABLE booking ADD COLUMN tenant_id uuid, ADD COLUMN attendee_email text,
        ADD COLUMN attendee_first_name text, ADD COLUMN attendee_last_name text;
      UPDATE booking SET tenant_id='${tenant}';
      INSERT INTO booking(id,event_id,status,tenant_id,attendee_email,attendee_first_name,attendee_last_name)
        VALUES('50000000-0000-4000-8000-000000000001','${event}','confirmed','${tenant}','guest@example.invalid','Guest','Person');
      UPDATE event SET waiting_list_enabled=true,pricing_config='{"ticket_classes":[{"id":"interest","name":"Interest","price":0}]}';`);
    sql(readFileSync(new URL('../../supabase/migrations/202612090002_guest_waiting_list_import.sql',import.meta.url),'utf8'));
    const guestBooking='50000000-0000-4000-8000-000000000001';
    const guestKey='60000000-0000-4000-8000-000000000001';
    const importGuest=(t=tenant,k=guestKey,sha='a'.repeat(64))=>`SELECT import_guest_event_waiting_registration('${t}','${guestBooking}','${sha}','Owner approved import','${k}');`;
    const beforeBookings=sql('SELECT jsonb_agg(to_jsonb(b) ORDER BY id)::text FROM booking b;');
    sql(`SET ROLE anon; ${importGuest()}`,false);
    sql(`SET ROLE authenticated; ${importGuest()}`,false);
    sql(importGuest(other),false);
    const guestId=sql(`SET ROLE service_role; ${importGuest()}`);
    assert.equal(sql(importGuest()),guestId,'guest replay idempotent');
    sql(importGuest(tenant,guestKey,'b'.repeat(64)),false);
    sql(importGuest(tenant,'60000000-0000-4000-8000-000000000002'),false,'no duplicate guest under a second key');
    const guestEntry=sql(`SELECT id FROM event_waiting_entry WHERE registration_id='${guestId}';`);
    assert.equal(sql(`SELECT booker_member_id IS NULL AND member_id IS NULL FROM event_waiting_entry WHERE id='${guestEntry}';`),'t');
    assert.equal(sql('SELECT jsonb_agg(to_jsonb(b) ORDER BY id)::text FROM booking b;'),beforeBookings);
    for(const who of [`'${member}'`,`'${colleague}'`,'NULL']) {
      for(const scope of ['attendee','registration'])
        sql(`SELECT withdraw_event_waiting_entry('${tenant}',${who},'${guestEntry}','${scope}');`,false);
    }
    sql(`UPDATE event_waiting_registration SET booker_member_id='${member}',registration_source='member',import_provenance=NULL WHERE id='${guestId}';`,false);
    sql(`UPDATE event_waiting_entry SET member_id='${member}' WHERE id='${guestEntry}';`,false);
    sql(`UPDATE event_waiting_entry SET tenant_id='${other}' WHERE id='${guestEntry}';`,false);
    sql(`INSERT INTO event_waiting_registration(tenant_id,event_id,event_kind,booker_member_id,idempotency_key,request_hash)
      VALUES('${tenant}','${event}','simple',NULL,gen_random_uuid(),'hash');`,false);
    // Existing member paths still register and withdraw after the migration.
    const finalId=sql(create(event,'simple','40000000-0000-4000-8000-000000000006'));
    const finalEntry=sql(`SELECT id FROM event_waiting_entry WHERE registration_id='${finalId}' AND member_id='${member}';`);
    assert.equal(sql(`SELECT withdraw_event_waiting_entry('${tenant}','${member}','${finalEntry}','registration');`),'2');
    // Read-only admin listing includes guests; ordinary member filters do not.
    assert.equal(sql(`SELECT count(*) FROM event_waiting_entry WHERE id='${guestEntry}' AND status='active';`),'1');
    assert.equal(sql(`SELECT count(*) FROM event_waiting_entry WHERE id='${guestEntry}' AND (booker_member_id='${member}' OR member_id='${member}');`),'0');
  } finally {
    if(started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(root,{recursive:true,force:true});
  }
});
