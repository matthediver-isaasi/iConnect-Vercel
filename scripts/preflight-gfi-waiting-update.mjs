// Read-only SQL generator for the exact owner-supplied workbook.
// Output contains private source evidence; never log or commit it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
const source='attached_assets/Update_import_on_waitlists_1795424758146.xlsx';
const bytes=fs.readFileSync(source);
assert.equal(createHash('sha256').update(bytes).digest('hex'),'aabb70e3c245cb96ff5aa37a04d963ed8b9635f2d12e569d4b99805076b4802b');
const workbook=XLSX.read(bytes);
assert.deepEqual(workbook.SheetNames,['Sheet1']);
const rows=XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1,{header:1,blankrows:true});
assert.equal(rows.length,22);
const titles={
  'bb3ded52-5d08-4719-806a-3c0bd65b866d':'AI Fast Track: Practical approaches for your role',
  'c0eda4f8-ff16-4708-b301-c2a5bb971ef2':'AI Fast Track: The student employer landscape',
};
const normalized=rows.map(([title,email,event,...extra],i)=>{
  assert.equal(extra.length,0); assert.equal(title,titles[event]);
  assert.equal(typeof email,'string'); email=email.trim().toLowerCase();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return {row:i+1,title,email,event};
});
assert.equal(new Set(normalized.map(r=>`${r.event}|${r.email}`)).size,22);
assert.deepEqual(Object.keys(titles).map(id=>normalized.filter(r=>r.event===id).length),[12,10]);
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const sql=`WITH source AS (
 SELECT * FROM jsonb_to_recordset(${literal(JSON.stringify(normalized))}::jsonb)
 AS s(row integer,title text,email text,event uuid)
)
SELECT s.row,s.event,
 (SELECT jsonb_build_object('title',e.title,'waiting',e.waiting_list_enabled,'status',e.status,
 'state',e.event_state,'closes',e.registration_closes_at,'pricing',e.pricing_config)
 FROM public.event e WHERE e.id=s.event AND e.tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d') event_config,
 (SELECT count(*) FROM public.member m WHERE m.tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d' AND lower(trim(m.email))=s.email) member_matches,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('status',w.status,'member',w.member_id IS NOT NULL)),'[]')
 FROM public.event_waiting_entry w WHERE w.tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d'
 AND w.event_id=s.event AND w.event_kind='simple' AND lower(trim(w.email))=s.email) existing,
 (SELECT count(*) FROM public.booking b WHERE b.tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d'
 AND b.event_id=s.event AND lower(trim(b.attendee_email))=s.email AND b.status='confirmed') guest_sources,
 (SELECT count(*) FROM public.booking b WHERE b.tenant_id='fd82da65-aab7-4a5c-85b8-b2febeb2003d'
 AND b.event_id=s.event AND lower(trim(b.attendee_email))=s.email AND b.status='confirmed'
 AND nullif(trim(b.attendee_first_name),'') IS NOT NULL AND nullif(trim(b.attendee_last_name),'') IS NOT NULL) named_guest_sources
FROM source s ORDER BY s.row;`;
fs.mkdirSync('private/gfi-waiting-update',{recursive:true,mode:0o700});
fs.writeFileSync('private/gfi-waiting-update/preflight.sql',sql,{mode:0o600});
// Generate, but never execute, a transaction. --apply only changes its final
// statement; the operator must submit the private SQL to the pinned destination.
const sha=createHash('sha256').update(bytes).digest('hex');
const original=fs.readFileSync('supabase/migrations/20261205_event_waiting_lists.sql','utf8');
const guest=fs.readFileSync('supabase/migrations/202612090002_guest_waiting_list_import.sql','utf8');
const body=(text,name)=>text.split(`FUNCTION public.${name}(`)[1].split('AS $$')[1].split('$$;')[0].trim();
const functions=[
 ['create_event_waiting_registration',original],
 ['import_guest_event_waiting_registration',guest],
 ['guard_waiting_entry_owner',guest],
 ['guard_waiting_registration_identity',guest],
];
const checks=functions.map(([name,text])=>`
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=${literal(name)} AND btrim(p.prosrc,E' \\n\\r\\t')=${literal(body(text,name))})<>1
 THEN RAISE EXCEPTION 'Reviewed function changed: ${name}'; END IF;`).join('\n');
const transaction=`BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.event_waiting_entry,public.event_waiting_registration IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.member,public.booking,public.event IN SHARE MODE;
DO $import$
#variable_conflict use_variable
DECLARE
 tenant uuid:='fd82da65-aab7-4a5c-85b8-b2febeb2003d';
 source jsonb:=${literal(JSON.stringify(normalized))}::jsonb;
 r record; e public.event; m public.member; ticket jsonb; payload jsonb;
 n integer; source_id uuid; key uuid; rid uuid; again uuid;
 before_rows jsonb; before_reg jsonb; after_rows jsonb;
 before_downstream jsonb:='{}'; after_downstream jsonb:='{}';
 tbl record; fingerprint text; pass integer; created integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=tenant AND name='Graduate Futures Institute')
 THEN RAISE EXCEPTION 'Tenant identity mismatch'; END IF;
 ${checks}
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.event_waiting_entry'::regclass,
 'public.event_waiting_registration'::regclass) AND NOT tgisinternal)<>2
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.event_waiting_entry'::regclass
 AND tgname='waiting_entry_owner' AND tgtype=23 AND tgenabled='O'
 AND tgfoid='public.guard_waiting_entry_owner()'::regprocedure)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.event_waiting_registration'::regclass
 AND tgname='waiting_registration_identity' AND tgtype=19 AND tgenabled='O'
 AND tgfoid='public.guard_waiting_registration_identity()'::regprocedure)
 THEN RAISE EXCEPTION 'Waiting triggers changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class IN ('public.event_waiting_entry'::regclass,
 'public.event_waiting_registration'::regclass)) THEN RAISE EXCEPTION 'Unexpected rules'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') INTO before_rows
 FROM public.event_waiting_entry w WHERE tenant_id=tenant;
 SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') INTO before_reg
 FROM public.event_waiting_registration w WHERE tenant_id=tenant;
 FOR pass IN 1..2 LOOP
 FOR tbl IN SELECT table_name FROM information_schema.columns
 WHERE table_schema='public' AND column_name='tenant_id'
 AND (table_name ~ '(invoice|workflow_log|notification|outbox|email_queue|payment)'
 OR table_name IN ('member','booking','complex_event_booking','member_cpd_points_ledger',
 'attendee_cpd_certificate_delivery','event')) LOOP
 EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]'')::text)
 FROM public.%I t WHERE tenant_id=$1',tbl.table_name) INTO fingerprint USING tenant;
 IF pass=1 THEN before_downstream:=before_downstream||jsonb_build_object(tbl.table_name,fingerprint);
 ELSE after_downstream:=after_downstream||jsonb_build_object(tbl.table_name,fingerprint); END IF;
 END LOOP;
 IF pass=2 THEN EXIT; END IF;
 FOR r IN SELECT * FROM jsonb_to_recordset(source) s(row integer,title text,email text,event uuid) ORDER BY row LOOP
 SELECT * INTO STRICT e FROM public.event WHERE id=r.event AND tenant_id=tenant;
 IF NOT e.waiting_list_enabled OR e.status NOT IN ('published','tbc','immediate')
 OR e.event_state IN ('cancelled','cancelling','closed','completed')
 OR (e.registration_closes_at IS NOT NULL AND e.registration_closes_at::timestamptz<=now())
 THEN RAISE EXCEPTION 'Event unavailable, row %',r.row; END IF;
 IF e.title IS DISTINCT FROM (CASE WHEN r.row<=12 THEN r.title
 ELSE 'AI Fast Track: The student-employer landscape' END) THEN RAISE EXCEPTION 'Event identity changed'; END IF;
 IF jsonb_array_length(e.pricing_config::jsonb->'ticket_classes') IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'Ambiguous ticket'; END IF;
 ticket:=e.pricing_config::jsonb->'ticket_classes'->0;
 IF (ticket->>'price')::numeric IS DISTINCT FROM 0 OR nullif(ticket->>'id','') IS NULL
 OR nullif(ticket->>'name','') IS NULL THEN RAISE EXCEPTION 'Invalid interest ticket'; END IF;
 SELECT count(*) INTO n FROM public.member WHERE tenant_id=tenant AND lower(trim(email))=r.email;
 IF n>1 OR (r.row=16 AND n<>0) OR (r.row NOT IN (8,16) AND n<>1)
 THEN RAISE EXCEPTION 'Member match changed, row %',r.row; END IF;
 SELECT count(*) INTO n FROM public.event_waiting_entry WHERE tenant_id=tenant AND event_id=r.event
 AND event_kind='simple' AND lower(trim(email))=r.email;
 IF n>0 THEN
 IF n<>1 OR EXISTS(SELECT 1 FROM public.event_waiting_entry WHERE tenant_id=tenant AND event_id=r.event
 AND event_kind='simple' AND lower(trim(email))=r.email AND status<>'active')
 THEN RAISE EXCEPTION 'Duplicate or withdrawn row %',r.row; END IF;
 CONTINUE;
 END IF;
 IF r.row<=12 THEN RAISE EXCEPTION 'Existing entry disappeared'; END IF;
 key:=md5('waiting-update|'||${literal(sha)}||'|'||tenant||'|'||r.event||'|'||r.email)::uuid;
 IF r.row=16 THEN
 SELECT count(*),(array_agg(id))[1] INTO n,source_id FROM public.booking
 WHERE tenant_id=tenant AND event_id=r.event AND lower(trim(attendee_email))=r.email AND status='confirmed';
 IF n<>1 THEN RAISE EXCEPTION 'Guest evidence changed'; END IF;
 rid:=public.import_guest_event_waiting_registration(tenant,source_id,${literal(sha)},'Owner authorised interest-only workbook update',key);
 again:=public.import_guest_event_waiting_registration(tenant,source_id,${literal(sha)},'Owner authorised interest-only workbook update',key);
 ELSE
 SELECT * INTO STRICT m FROM public.member WHERE tenant_id=tenant AND lower(trim(email))=r.email;
 IF nullif(trim(m.first_name),'') IS NULL OR nullif(trim(m.last_name),'') IS NULL
 THEN RAISE EXCEPTION 'Missing member identity, row %',r.row; END IF;
 payload:=jsonb_build_array(jsonb_build_object('member_id',m.id,'email',r.email,'first_name',m.first_name,
 'last_name',m.last_name,'job_title',m.job_title,'ticket_class_id',ticket->>'id','ticket_name',ticket->>'name',
 'advertised_price',0,'currency','GBP','session_ids','[]'::jsonb,
 'attendee_details',jsonb_build_object('import_source_sha256',${literal(sha)},'import_kind','owner_authorised_waiting_list_only')));
 rid:=public.create_event_waiting_registration(tenant,m.id,r.event,'simple',key,md5(payload::text),payload);
 again:=public.create_event_waiting_registration(tenant,m.id,r.event,'simple',key,md5(payload::text),payload);
 END IF;
 IF rid IS DISTINCT FROM again THEN RAISE EXCEPTION 'Replay identity mismatch'; END IF;
 created:=created+1;
 END LOOP;
 END LOOP;
 IF before_downstream IS DISTINCT FROM after_downstream THEN RAISE EXCEPTION 'Downstream records changed'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') INTO after_rows FROM public.event_waiting_entry w
 WHERE id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(before_rows));
 IF after_rows IS DISTINCT FROM before_rows THEN RAISE EXCEPTION 'Existing entries changed'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') INTO after_rows FROM public.event_waiting_registration w
 WHERE id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(before_reg));
 IF after_rows IS DISTINCT FROM before_reg THEN RAISE EXCEPTION 'Existing registrations changed'; END IF;
 SELECT count(*) INTO n FROM public.event_waiting_entry w
 JOIN jsonb_to_recordset(source) s(event uuid,email text) ON w.event_id=s.event AND lower(trim(w.email))=s.email
 WHERE w.tenant_id=tenant AND w.event_kind='simple' AND w.status='active';
 IF n<>22 OR created NOT IN (0,10) THEN RAISE EXCEPTION 'Unexpected final totals'; END IF;
END $import$;
${sql}
${process.argv.includes('--apply')?'COMMIT':'ROLLBACK'};`;
fs.writeFileSync(`private/gfi-waiting-update/${process.argv.includes('--apply')?'apply':'rehearsal'}.sql`,transaction,{mode:0o600});
console.log('Validated 22 rows; private read-only preflight SQL prepared.');
