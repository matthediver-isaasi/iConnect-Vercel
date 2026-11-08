import { connectDestination } from './lib/member-index-destination.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const option = key => process.argv[process.argv.indexOf(key) + 1];
for (const key of ['--tenant','--class-field','--date-field']) {
  assert.ok(process.argv.includes(key) && /^[0-9a-f-]{36}$/i.test(option(key)), `${key} UUID required`);
}
assert.ok(process.argv.includes('--class-value'), 'Class value required');
const db = await connectDestination();
try {
  await db.query('begin read only');
  const values = [option('--tenant'),option('--class-field'),option('--date-field'),option('--class-value')];
  const { rows } = await db.query(`
    select m.id,m.first_name,m.last_name,m.email,m.status,course.value course_end,
      coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'start',h.term_start_date,'end',h.term_end_date,
        'status',h.status,'payment_status',h.payment_status,'invoice',h.xero_invoice_number))
        from member_membership_history h where h.tenant_id=m.tenant_id and h.member_id=m.id),'[]') history,
      coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'form_id',s.form_id,'status',s.status,
        'submitted',s.created_date,'processed',s.entity_processing_completed_at,
        'identity_match',case when s.created_member_id=m.id then 'member ID' else 'email only' end))
        from form_submission s where s.tenant_id=m.tenant_id and not coalesce(s.is_anonymous,false)
          and (s.created_member_id=m.id or (s.created_member_id is null and lower(s.submitted_by_email)=lower(m.email)))),'[]') submissions
    from member m join member_preference_value class on class.member_id=m.id and class.field_id=$2
    left join member_preference_value course on course.member_id=m.id and course.field_id=$3
    where m.tenant_id=$1 and class.value=$4 order by m.last_name,m.first_name,m.id`,values);
  await db.query('rollback');
  const quote = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  const columns = ['Member ID','First name','Last name','Email','Record status','Saved course end date','Membership history evidence','Candidate submission evidence','Review required'];
  const records = rows.map(r => [r.id,r.first_name,r.last_name,r.email,r.status,r.course_end,
    JSON.stringify(r.history),JSON.stringify(r.submissions),
    !r.course_end ? 'Course end date missing; do not reconstruct'
      : r.history.length ? 'Compare existing history and establish authoritative start; no reconstruction approved'
        : 'End-date candidate only; verify authoritative start before reconstruction']);
  const dir = 'generated-artifacts/student-membership-audit';
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path = join(dir,'membership-date-evidence.csv');
  writeFileSync(path,[columns,...records].map(r=>r.map(quote).join(',')).join('\r\n'),{mode:0o600});
  console.log(JSON.stringify({readOnly:true,records:rows.length,
    withCourseEnd:rows.filter(r=>r.course_end).length,missingCourseEnd:rows.filter(r=>!r.course_end).length,
    withHistory:rows.filter(r=>r.history.length).length,withCandidateSubmissions:rows.filter(r=>r.submissions.length).length,
    path,recordsChanged:0}));
} finally {await db.end();}
