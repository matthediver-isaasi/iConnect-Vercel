// Explicit field allowlist; never infer review visibility from a form being
// public, an answer existing, or the judge knowing a canonical submission ID.
import {isRepeatableRowField,repeatableRowChildren,getRepeatableRowHiddenChildIds} from '../../../shared/formRepeatableRows.js';
const scalarTypes=new Set(['text','textarea','email','number','tel','date','time','country','percentage','currency','boolean','select','dropdown','radio','url','score','terms_conditions','custom_field','category_dropdown']);
const managedTypes=new Set(['relationship_dropdown','organisation_dropdown','organisation_group_dropdown']);
const primitive=value=>value===null||value===undefined||['string','number','boolean'].includes(typeof value);
function safeValue(field,value,depth=0,display){
  if(depth>4||field.due_diligence||field.hidden===true||field.hidden==='true')return undefined;
  if(managedTypes.has(field.type)){
    if(typeof display==='string')return display;
    if(primitive(value))return value?`Recorded reference (label unavailable): ${value}`:null;
    if(Array.isArray(value)&&value.every(primitive))return value.map(item=>`Recorded reference (label unavailable): ${item}`);
    return undefined;
  }
  if(scalarTypes.has(field.type)&&primitive(value))return value??null;
  if(['checkbox','countries','list','category_multiselect','custom_field'].includes(field.type)&&Array.isArray(value)&&value.every(primitive))return [...value];
  if(['contact','user_organization'].includes(field.type)&&value&&typeof value==='object'&&!Array.isArray(value)){
    const keys=field.type==='contact'?['first_name','last_name','name','email','phone','job_title','organization']:['name','organization_name','not_listed_name','id','organization_id'];
    return keys.filter(key=>Object.hasOwn(value,key)&&primitive(value[key])).map(key=>`${key.replaceAll('_',' ')}: ${value[key]??''}`);
  }
  if(field.type==='grouped_question'&&value&&typeof value==='object'&&!Array.isArray(value)){
    return (Array.isArray(field.sub_questions)?field.sub_questions:[]).flatMap(child=>{
      const answer=safeValue({...child,type:child.type||'textarea'},value[child.id],depth+1);
      return answer===undefined?[]:[`${child.label||child.title||child.id}: ${answer??'No response'}`];
    });
  }
  if(field.type==='signature'&&value?.type==='signature'&&typeof value.data==='string'
    &&value.data.length<=500000&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value.data)){
    return{image:value.data,signedAt:typeof value.signed_at==='string'&&Number.isFinite(Date.parse(value.signed_at))?value.signed_at:null};
  }
  if(isRepeatableRowField(field)&&Array.isArray(value)){
    const children=repeatableRowChildren(field);
    if(!children.length)return undefined;
    return value.map((row,index)=>{
      if(!row||typeof row!=='object'||Array.isArray(row))return `Row ${index+1}: invalid recorded row`;
      const hidden=getRepeatableRowHiddenChildIds(field,row);
      const parts=children.filter(child=>!hidden.has(String(child.id))).flatMap(child=>{
        const answer=safeValue(child,row[child.id],depth+1,display?.[JSON.stringify([row._row_id,child.id])]);
        return answer===undefined?[]:[`${child.label||child.id}: ${Array.isArray(answer)?answer.join('; '):answer??'No response'}`];
      });
      return `Row ${index+1}\n${parts.join('\n')}`;
    });
  }
  if(['address','address_lookup'].includes(field.type)&&value&&typeof value==='object'&&!Array.isArray(value)){
    const keys=['line1','line2','line_1','line_2','line_3','building_name','post_town','address_line1','address_line2','address_line_1','address_line_2','street','city','town','state','county','postcode','postal_code','country','formatted_address'];
    return keys.filter(key=>Object.hasOwn(value,key)&&primitive(value[key]))
      .map(key=>`${key.replaceAll('_',' ')}: ${value[key]??''}`);
  }
  return undefined;
}
export function reviewProjection(snapshot){
  const form=snapshot?.form_snapshot||{};
  const allowed=new Set(Array.isArray(form.review_field_ids)?form.review_field_ids:[]);
  const answers=snapshot?.answer_snapshot||{};
  const fields=[],attachments=[];
  for(const field of Array.isArray(form.fields)?form.fields:[]){
    if(!field?.id||!allowed.has(field.id)||field.due_diligence||field.hidden===true||field.hidden==='true')continue;
    if(field.type==='file'){
      for(const file of snapshot.attachment_manifest||[]){
        if(file.field_id===field.id&&typeof file.id==='string')attachments.push({id:file.id,label:String(field.label||'Attachment'),name:String(file.name||'Attachment')});
      }
      continue;
    }
    if(isRepeatableRowField(field)){
      const rows=Array.isArray(answers[field.id])?answers[field.id]:[];
      for(const file of snapshot.attachment_manifest||[]){
        if(file.field_id!==field.id||typeof file.id!=='string'||!file.cell_id)continue;
        let cell;try{cell=JSON.parse(file.cell_id);}catch{continue;}
        if(!Array.isArray(cell)||cell.length!==2||!cell.every(value=>typeof value==='string'))continue;
        const matches=rows.filter(row=>row?._row_id===cell[0]);
        const child=repeatableRowChildren(field).find(child=>child.id===cell[1]);
        if(matches.length!==1||child?.type!=='file'||child.due_diligence||child.hidden===true||child.hidden==='true'
          ||getRepeatableRowHiddenChildIds(field,matches[0]).has(String(child.id)))continue;
        attachments.push({id:file.id,label:`${field.label||field.id} — Row ${rows.indexOf(matches[0])+1} — ${child.label||child.id}`,name:String(file.name||'Attachment')});
      }
    }
    const value=answers[field.id];
    const projected=safeValue(field,value,0,snapshot?.display_snapshot?.[field.id]);
    if(projected!==undefined)fields.push({id:field.id,label:String(field.label||field.id),type:field.type,value:projected});
    // Unknown composite/relationship structures remain closed, never blindly
    // serialized with undeclared child keys, URLs or live directory metadata.
  }
  return{fields,attachments};
}
