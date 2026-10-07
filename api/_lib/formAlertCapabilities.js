import { createHash, randomBytes } from 'node:crypto';
import { projectFormAlertAnswers } from './formAlertProjection.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../shared/formRepeatableRows.js';
import { loadTenantRelationshipDisplayLabels } from './relationshipDisplayLabels.js';

export function createFormAlertToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
export function hashFormAlertToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? createHash('sha256').update(token).digest('hex') : null;
}

export async function resolveFormAlertCapability(db, tenantId, token, now = Date.now()) {
  const hash = hashFormAlertToken(token);
  if (!hash || !tenantId) return null;
  const { data: delivery, error } = await db.from('form_alert_delivery')
    .select('tenant_id,form_id,submission_id,status,expires_at,revoked_at,form_snapshot')
    .eq('tenant_id',tenantId).eq('token_hash',hash).maybeSingle();
  if (error) throw error;
  if (!delivery || delivery.status !== 'sent' || delivery.revoked_at
    || !Number.isFinite(Date.parse(delivery.expires_at)) || Date.parse(delivery.expires_at) <= now) return null;
  const { data: form, error: formError } = await db.from('form').select('id,form_type')
    .eq('tenant_id',tenantId).eq('id',delivery.form_id).maybeSingle();
  if (formError) throw formError;
  if (!form) return null;
  const { data: submission, error: submissionError } = await db.from('form_submission')
    .select('id,submission_data,created_date,is_anonymous,survey_version_id,survey_assignment_id')
    .eq('tenant_id',tenantId).eq('form_id',delivery.form_id).eq('id',delivery.submission_id).maybeSingle();
  if (submissionError) throw submissionError;
  if (!submission) return null;
  let fields=delivery.form_snapshot?.fields;
  let anonymous=submission.is_anonymous === true;
  if (form.form_type === 'survey' || submission.survey_version_id) {
    if (!submission.survey_version_id) return null;
    const { data: version, error: versionError } = await db.from('survey_version')
      .select('fields,survey_settings').eq('tenant_id',tenantId).eq('form_id',delivery.form_id)
      .eq('id',submission.survey_version_id).maybeSingle();
    if (versionError) throw versionError;
    if (!version?.survey_settings || !Array.isArray(version.fields)) return null;
    fields=version.fields;
    anonymous ||= (version.survey_settings.response_identity || 'identified') !== 'identified';
    if (anonymous) {
      const threshold=Math.max(3,Number(version.survey_settings.anonymity_threshold) || 3);
      let cohort=db.from('form_submission').select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('form_id',delivery.form_id)
        .eq('survey_version_id',submission.survey_version_id).eq('is_anonymous',true).neq('status','junk');
      cohort=submission.survey_assignment_id ? cohort.eq('survey_assignment_id',submission.survey_assignment_id)
        : cohort.is('survey_assignment_id',null);
      const {count,error:countError}=await cohort;
      if (countError) throw countError;
      if (!Number.isInteger(count) || count<threshold) return null;
    }
  } else if (anonymous) return null; // Unknown anonymous policy must fail closed.
  if (!Array.isArray(fields)) return null;
  const options={anonymous,attachments:[],tenantId,submissionId:delivery.submission_id};
  if (!anonymous) {
    const ids={relationship_dropdown:new Set(),organisation_dropdown:new Set(),organisation_group_dropdown:new Set()};
    const collect=(definitions,values)=>{
      for(const field of definitions||[]) {
        const value=values?.[field.id];
        if(ids[field.type]) for(const id of (Array.isArray(value)?value:[value])) {
          if(typeof id==='string' && /^[a-f0-9-]{36}$/i.test(id)) ids[field.type].add(id);
        }
        if(isRepeatableRowField(field)) for(const row of Array.isArray(value)?value:[]) collect(repeatableRowChildren(field),row);
        if(field.type==='grouped_question') collect(field.sub_questions,value);
      }
    };
    collect(fields,submission.submission_data);
    if(Object.values(ids).some(set=>set.size>2000)) return null;
    options.relationshipLabels=ids.relationship_dropdown.size
      ? await loadTenantRelationshipDisplayLabels(db,tenantId,[...ids.relationship_dropdown]):{};
    for(const [type,table,key] of [['organisation_dropdown','organization','organizationLabels'],
      ['organisation_group_dropdown','organization_group','groupLabels']]) {
      options[key]={};
      const list=[...ids[type]];
      for(let offset=0;offset<list.length;offset+=100) {
        const {data,error}=await db.from(table).select('id,name').eq('tenant_id',tenantId).in('id',list.slice(offset,offset+100));
        if(error) throw error;
        for(const row of data||[]) options[key][row.id]=row.name;
      }
    }
  }
  return {
    form_name: String(delivery.form_snapshot?.name || 'Form submission'),
    submitted_at: anonymous ? String(submission.created_date || '').slice(0,10) : submission.created_date,
    anonymous,
    answers: projectFormAlertAnswers(fields,submission.submission_data,options),
    attachments: options.attachments,
  };
}
