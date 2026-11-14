import {isRepeatableRowField,repeatableRowChildren} from '../../../shared/formRepeatableRows.js';
import {loadFormSubmissionRelationshipLabels,loadFormSubmissionOrganisationLabels,loadFormSubmissionOrganisationGroupLabels,
  formatFormSubmissionFieldValue} from '../formSubmissionPdf.js';
export const managedReviewTypes=new Set(['relationship_dropdown','organisation_dropdown','organisation_group_dropdown']);

// Resolve labels once from the canonical tenant-scoped reference services.
// Immutable answer IDs remain untouched; this is review presentation evidence,
// not another directory or a live judge-side lookup.
export async function buildReviewDisplaySnapshot(db,{tenantId,submissionId,copyFromApplication=null}){
  const {data:capture,error}=await db.from('awards_intake_capture').select('form_snapshot,answer_snapshot')
    .eq('tenant_id',tenantId).eq('submission_id',submissionId).single();
  if(error||!capture)throw new Error('Review display evidence could not be read');
  const allowed=new Set(capture.form_snapshot.review_field_ids||[]),result={};
  const fields=(capture.form_snapshot.fields||[]).filter(field=>allowed.has(field.id)&&!field.due_diligence);
  if(!fields.some(field=>managedReviewTypes.has(field.type)||(isRepeatableRowField(field)&&repeatableRowChildren(field).some(child=>managedReviewTypes.has(child.type)))))return{};
  let previous=null;
  if(copyFromApplication){
    const saved=await db.from('awards_application_version').select('answer_snapshot,display_snapshot')
      .eq('tenant_id',tenantId).eq('application_id',copyFromApplication).order('revision',{ascending:false}).limit(1).maybeSingle();
    if(saved.error)throw new Error('Original display evidence could not be verified');
    previous=saved.data;
  }
  const unchanged=(oldValue,value)=>JSON.stringify(oldValue)===JSON.stringify(value);
  const resolve=async(fields,answers)=>{
    const selected=fields.filter(field=>managedReviewTypes.has(field.type)&&!field.due_diligence);
    if(!selected.length)return{};
    const [relationships,organisations,groups]=await Promise.all([
      loadFormSubmissionRelationshipLabels({db,tenantId,fields:selected,submissionData:answers}),
      loadFormSubmissionOrganisationLabels({db,tenantId,fields:selected,submissionData:answers}),
      loadFormSubmissionOrganisationGroupLabels({db,tenantId,fields:selected,submissionData:answers}),
    ]);
    return Object.fromEntries(selected.map(field=>[field.id,formatFormSubmissionFieldValue(field,answers[field.id],relationships,answers,organisations,groups)]));
  };
  Object.assign(result,await resolve(fields,capture.answer_snapshot));
  for(const field of fields)if(managedReviewTypes.has(field.type)&&typeof previous?.display_snapshot?.[field.id]==='string'
    &&unchanged(previous.answer_snapshot[field.id],capture.answer_snapshot[field.id]))result[field.id]=previous.display_snapshot[field.id];
  for(const field of fields){
    if(!isRepeatableRowField(field))continue;
    const rows=capture.answer_snapshot[field.id];
    if(!Array.isArray(rows))continue;
    const cells={};
    for(const row of rows){
      const labels=await resolve(repeatableRowChildren(field),row);
      if(Object.keys(labels).length&&typeof row._row_id!=='string')throw new Error('Managed review rows require stable identities');
      for(const [child,label]of Object.entries(labels)){
        const key=JSON.stringify([row._row_id,child]),oldRows=previous?.answer_snapshot?.[field.id];
        const old=Array.isArray(oldRows)?oldRows.find(item=>item?._row_id===row._row_id):null;
        cells[key]=old&&unchanged(old[child],row[child])&&typeof previous?.display_snapshot?.[field.id]?.[key]==='string'
          ?previous.display_snapshot[field.id][key]:label;
      }
    }
    if(Object.keys(cells).length)result[field.id]=cells;
  }
  return result;
}
