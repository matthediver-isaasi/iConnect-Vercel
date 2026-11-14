import {createHash} from 'node:crypto';
import {scopedFormAlertAttachment} from '../formAlertAttachments.js';
import {isRepeatableRowField,repeatableRowChildren} from '../../../shared/formRepeatableRows.js';
export async function captureReviewAttachments(database,{tenantId,submissionId,copyFromApplication=null}){
  const {data:capture,error}=await database.from('awards_intake_capture').select('form_snapshot,answer_snapshot')
    .eq('tenant_id',tenantId).eq('submission_id',submissionId).single();
  if(error||!capture)throw new Error('The saved review snapshot could not be read');
  const allowed=new Set(capture.form_snapshot.review_field_ids||[]);
  for(const field of capture.form_snapshot.fields||[]){
    if(!allowed.has(field.id)||field.due_diligence)continue;
    const cells=field.type==='file'?[{id:'',answer:capture.answer_snapshot[field.id]}]:[];
    if(isRepeatableRowField(field)){
      const rows=capture.answer_snapshot[field.id]||[],seen=new Set();
      if(!Array.isArray(rows))throw new Error('Repeatable file evidence is malformed');
      const children=repeatableRowChildren(field).filter(child=>child.type==='file'&&!child.due_diligence);
      for(const row of rows){
        if(!children.length)break;
        if(!row||typeof row._row_id!=='string'||!row._row_id||seen.has(row._row_id))throw new Error('Repeatable file evidence needs unique stable row identifiers');
        seen.add(row._row_id);
        for(const child of children)cells.push({id:`[${JSON.stringify(row._row_id)}, ${JSON.stringify(child.id)}]`,answer:row[child.id]});
      }
    }
    for(const cell of cells){
    const answer=cell.answer;
    if(answer===null||answer===undefined||answer==='')continue;
    if(copyFromApplication){
      const copied=await database.rpc(cell.id?'awards_copy_amendment_cell_files':'awards_copy_amendment_files',{
        p_tenant:tenantId,p_application:copyFromApplication,p_submission:submissionId,p_field:field.id,...(cell.id?{p_cell:cell.id}:{})});
      if(copied.error)throw new Error('Retained amendment files could not be verified');
      if(copied.data===true)continue;
    }
    for(const value of Array.isArray(answer)?answer:[answer]){
      const source=scopedFormAlertAttachment(value,tenantId,submissionId);
      if(!source)throw new Error('Review attachments must be private files belonging to this exact submission');
      const retained=await database.from('awards_review_attachment').select('id')
        .eq('tenant_id',tenantId).eq('submission_id',submissionId).eq('field_id',field.id).eq('cell_id',cell.id).eq('source_path',source.path).maybeSingle();
      if(retained.error)throw new Error('Retained attachment evidence could not be verified');
      if(retained.data)continue;
      const {data:file,error:downloadError}=await database.storage.from(source.bucket).download(source.path);
      if(downloadError||!file)throw new Error('An attachment could not be retained; retry application completion');
      if(file.size<1||file.size>25*1024*1024)throw new Error('Review attachment exceeds the existing 25 MB upload limit');
      const bytes=Buffer.from(await file.arrayBuffer());
      const {error:storeError}=await database.rpc('awards_capture_attachment',{
        p_tenant:tenantId,p_submission:submissionId,p_field:field.id,p_path:source.path,p_name:source.name,
        p_hex:bytes.toString('hex'),p_digest:createHash('sha256').update(bytes).digest('hex'),
        p_cell:cell.id,
      });
      if(storeError)throw new Error('An immutable attachment snapshot could not be retained; retry application completion');
    }
    }
  }
}
