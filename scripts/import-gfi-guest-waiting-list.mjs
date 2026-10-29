// Owner-approved completion of the pinned waiting-list workbook. No provider,
// email, workflow, booking or account creation calls. Default rolls back.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {connectDestination} from './annual-meeting-destination.mjs';
const SHA='296f607da122405c425ad4cdd65f0ba360ffa57a1ceccb4c20407ef95b810c39';
const TENANT='fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const hash=x=>createHash('sha256').update(x).digest('hex');
const bytes=fs.readFileSync('attached_assets/Waitlists_ALL_1793283614417.xlsx');
assert.equal(hash(bytes),SHA);
const workbook=XLSX.read(bytes);
assert.deepEqual(workbook.SheetNames,['Sheet1']);
const raw=XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1);
assert.equal(raw.length,89);
const rows=[...new Map(raw.map(r=>{
  const event=String(r['Event UUID']).trim(),email=String(r.Email).trim().toLowerCase();
  assert(/^[0-9a-f-]{36}$/.test(event)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return [`${event}|${email}`,{event,email}];
})).values()];
assert.equal(rows.length,83);
const eventIds=[...new Set(rows.map(r=>r.event))].sort();
const migration=fs.readFileSync('supabase/migrations/202612090002_guest_waiting_list_import.sql','utf8')
  .replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
const db=await connectDestination();
try{
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  const present=(await db.query(`select to_regprocedure('public.import_guest_event_waiting_registration(uuid,uuid,text,text,uuid)') name`)).rows[0].name;
  if(!present)await db.query(migration);
  const actual=(await db.query(`select prosrc from pg_proc where oid=
    'public.import_guest_event_waiting_registration(uuid,uuid,text,text,uuid)'::regprocedure`)).rows[0].prosrc.trim();
  assert.equal(actual,migration.split('CREATE FUNCTION public.import_guest_event_waiting_registration(')[1].split('AS $$')[1].split('$$;')[0].trim());
  const triggers=(await db.query(`select t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relname in ('event_waiting_entry','event_waiting_registration') and not t.tgisinternal order by t.tgname`)).rows;
  assert.deepEqual(triggers.map(t=>t.tgname),['waiting_entry_owner','waiting_registration_identity']);
  await db.query('LOCK TABLE event_waiting_entry,event_waiting_registration IN SHARE ROW EXCLUSIVE MODE');
  const members=(await db.query(`select id,email from member where tenant_id=$1
    and lower(trim(email))=any($2::text[]) for share`,[TENANT,[...new Set(rows.map(r=>r.email))]])).rows;
  const guests=rows.filter(r=>!members.some(m=>m.email.trim().toLowerCase()===r.email));
  assert.equal(guests.length,23);
  const beforeWaiting=(await db.query(`select to_jsonb(w) value from event_waiting_entry w
    where tenant_id=$1 and event_id=any($2::uuid[]) order by id`,[TENANT,eventIds])).rows;
  const beforeIds=beforeWaiting.map(r=>r.value.id);
  const snapshot=async()=>{
    const result={};
    for(const table of ['booking','complex_event_booking','member','member_cpd_points_ledger','event_cpd_points_outbox',
      'event_cpd_badge_outbox','attendee_cpd_certificate_delivery','event_invoice_recovery']){
      const scoped=['booking','complex_event_booking','member_cpd_points_ledger'].includes(table);
      const data=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) value
        from ${table} t where tenant_id=$1${scoped?' and event_id=any($2::uuid[])':''}`,scoped?[TENANT,eventIds]:[TENANT])).rows[0].value;
      result[table]=hash(JSON.stringify(data));
    }
    return result;
  };
  const before=await snapshot();
  const titles=new Map((await db.query('select id,title from event where tenant_id=$1 and id=any($2::uuid[]) for share',[TENANT,eventIds])).rows.map(e=>[e.id,e.title]));
  assert.equal(titles.size,4);
  const totals={};
  let created=0;
  for(const row of guests){
    const sources=(await db.query(`select id from booking where tenant_id=$1 and event_id=$2
      and lower(trim(attendee_email))=$3 and status='confirmed' for share`,[TENANT,row.event,row.email])).rows;
    assert.equal(sources.length,1,'Ambiguous or absent source booking');
    const key=hash(`guest-waiting-import|${SHA}|${TENANT}|${row.event}|${row.email}`).slice(0,32);
    const uuid=`${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20)}`;
    const prior=(await db.query(`select id from event_waiting_registration where tenant_id=$1 and idempotency_key=$2
      and registration_source='guest_import'`,[TENANT,uuid])).rows;
    const args=[TENANT,sources[0].id,SHA,'Project owner approved guest waiting-list import',uuid];
    const registration=(await db.query('select import_guest_event_waiting_registration($1,$2,$3,$4,$5) id',args)).rows[0].id;
    assert.equal((await db.query('select import_guest_event_waiting_registration($1,$2,$3,$4,$5) id',args)).rows[0].id,registration);
    const imported=(await db.query(`select id,booker_member_id,member_id,status,email from event_waiting_entry where registration_id=$1`,[registration])).rows;
    assert.equal(imported.length,1);
    assert.equal(imported[0].booker_member_id,null);assert.equal(imported[0].member_id,null);
    assert.equal(imported[0].status,'active');assert.equal(imported[0].email,row.email);
    if(!prior.length){created++;totals[titles.get(row.event)]=(totals[titles.get(row.event)]||0)+1;}
  }
  assert.deepEqual(await snapshot(),before,'Downstream or member/source records changed');
  assert.deepEqual((await db.query(`select to_jsonb(w) value from event_waiting_entry w where id=any($1::uuid[]) order by id`,[beforeIds])).rows,beforeWaiting);
  const total=(await db.query(`select count(*) n from event_waiting_entry w
    join jsonb_to_recordset($2::jsonb) s(event uuid,email text) on w.event_id=s.event and lower(trim(w.email))=s.email
    where w.tenant_id=$1 and w.status='active'`,[TENANT,JSON.stringify(rows)])).rows[0].n;
  assert.equal(Number(total),83);
  for(const role of ['anon','authenticated','service_role']){
    const p=(await db.query(`select has_function_privilege($1,
      'public.import_guest_event_waiting_registration(uuid,uuid,text,text,uuid)','EXECUTE') allowed`,[role])).rows[0];
    assert.equal(p.allowed,role==='service_role');
  }
  await db.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({committed:process.argv.includes('--apply'),created,existingGuests:23-created,
    byEvent:totals,totalWorkbookEntries:Number(total),sourceRows:89,duplicates:6,
    existingEntriesUnchanged:true,downstreamUnchanged:true,memberAccountsCreated:0}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
