// Reviewed workbook import into interest-only storage. Default is rollback.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {connectDestination} from './annual-meeting-destination.mjs';

const PATH='attached_assets/Waitlists_ALL_1793283614417.xlsx';
const SHA='296f607da122405c425ad4cdd65f0ba360ffa57a1ceccb4c20407ef95b810c39';
const TENANT='fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const hash=x=>createHash('sha256').update(x).digest('hex');
const bytes=fs.readFileSync(PATH); assert.equal(hash(bytes),SHA);
const workbook=XLSX.read(bytes);
assert.deepEqual(workbook.SheetNames,['Sheet1']);
const raw=XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1);
assert.equal(raw.length,89);
const rows=[...new Map(raw.map(row=>{
  assert.deepEqual(Object.keys(row).sort(),['Email','Event UUID']);
  const event=String(row['Event UUID']).trim();
  const email=String(row.Email).trim().toLowerCase();
  assert(/^[0-9a-f-]{36}$/.test(event)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return [`${event}|${email}`,{event,email}];
})).values()];
assert.equal(rows.length,83);
const eventIds=[...new Set(rows.map(r=>r.event))].sort();
assert.equal(eventIds.length,4);
const db=await connectDestination();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  // Verify the actual live writer, not just the checked-in migration.
  const expected=fs.readFileSync('supabase/migrations/20261205_event_waiting_lists.sql','utf8')
    .split('CREATE FUNCTION public.create_event_waiting_registration(')[1].split('AS $$')[1].split('$$;')[0].trim();
  const actual=(await db.query(`select prosrc from pg_proc where oid=
    'public.create_event_waiting_registration(uuid,uuid,uuid,text,uuid,text,jsonb)'::regprocedure`)).rows[0].prosrc.trim();
  assert.equal(actual,expected,'Live waiting-list writer changed; review side effects before importing');
  const triggers=(await db.query(`select t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relname in ('event_waiting_entry','event_waiting_registration') and not t.tgisinternal`)).rows;
  assert.equal(triggers.length,0,'Unexpected downstream waiting-list triggers');
  await db.query('LOCK TABLE event_waiting_entry,event_waiting_registration IN SHARE ROW EXCLUSIVE MODE');
  const events=(await db.query('select * from event where tenant_id=$1 and id=any($2::uuid[]) order by id for share',
    [TENANT,eventIds])).rows;
  assert.equal(events.length,4);
  const snapshot=async()=> {
    const evidence={};
    for(const table of ['booking','complex_event_booking','member_cpd_points_ledger','event_cpd_points_outbox',
      'event_cpd_badge_outbox','attendee_cpd_certificate_delivery','event_invoice_recovery']){
      const eventScoped=['booking','complex_event_booking','member_cpd_points_ledger'].includes(table);
      const filter=eventScoped?'tenant_id=$1 and event_id=any($2::uuid[])':'tenant_id=$1';
      const values=eventScoped?[TENANT,eventIds]:[TENANT];
      const data=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) value
        from ${table} t where ${filter}`,values)).rows[0].value;
      evidence[table]=hash(JSON.stringify(data));
    }
    return evidence;
  };
  const before=await snapshot();
  const members=(await db.query(`select id,email,first_name,last_name,job_title from member where tenant_id=$1
    and lower(trim(email))=any($2::text[]) for share`,[TENANT,[...new Set(rows.map(r=>r.email))]])).rows;
  const results={created:0,existing:0,unmatched:0,byEvent:{}};
  for(const row of rows){
    const event=events.find(e=>e.id===row.event);
    assert(event.waiting_list_enabled&&['published','tbc','immediate'].includes(event.status));
    assert(!['cancelled','cancelling','closed','completed'].includes(event.event_state));
    const matches=members.filter(m=>m.email.trim().toLowerCase()===row.email);
    assert(matches.length<=1,'Ambiguous member identity');
    results.byEvent[event.title] ||= {created:0,existing:0,unmatched:0};
    if(!matches.length){results.unmatched++;results.byEvent[event.title].unmatched++;continue;}
    const m=matches[0];
    const existing=(await db.query(`select id,status from event_waiting_entry where tenant_id=$1 and event_id=$2
      and event_kind='simple' and lower(trim(email))=$3`,[TENANT,row.event,row.email])).rows;
    if(existing.length){
      assert(existing.every(e=>e.status==='active'),'Do not reinstate a withdrawn entry');
      results.existing++;results.byEvent[event.title].existing++;continue;
    }
    const tickets=event.pricing_config?.ticket_classes;
    assert(tickets?.length===1&&Number(tickets[0].price)===0,'Ticket selection requires review');
    const ticket=tickets[0];
    const key=hash(`${SHA}|${TENANT}|${row.event}|${row.email}`).slice(0,32);
    const uuid=`${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20)}`;
    const entries=[{member_id:m.id,email:row.email,first_name:m.first_name||'',last_name:m.last_name||'',
      job_title:m.job_title||null,ticket_class_id:ticket.id,ticket_name:ticket.name,
      advertised_price:0,currency:'GBP',session_ids:[],
      attendee_details:{import_source_sha256:SHA,import_kind:'owner_authorised_waiting_list_only'}}];
    await db.query(`select create_event_waiting_registration($1,$2,$3,'simple',$4,$5,$6::jsonb)`,
      [TENANT,m.id,row.event,uuid,hash(JSON.stringify(entries)),JSON.stringify(entries)]);
    results.created++;results.byEvent[event.title].created++;
  }
  assert.equal(results.unmatched,23);
  assert.equal(results.created+results.existing,60);
  assert.deepEqual(await snapshot(),before,'Downstream or historical records changed');
  const retained=(await db.query(`select count(*) n from event_waiting_entry w
    join jsonb_to_recordset($3::jsonb) s(event uuid,email text) on w.event_id=s.event and lower(trim(w.email))=s.email
    where w.tenant_id=$1 and w.event_id=any($2::uuid[]) and w.status='active'`,
    [TENANT,eventIds,JSON.stringify(rows)])).rows[0].n;
  assert.equal(Number(retained),60);
  await db.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({committed:process.argv.includes('--apply'),sourceRows:89,duplicateSourceRows:6,
    ...results,downstreamUnchanged:true}));
} catch(error){await db.query('ROLLBACK');throw error;} finally{await db.end();}
