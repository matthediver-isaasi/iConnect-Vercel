import {inspectPdf,renderCpdCertificatePdf} from '../cpdCertificatePdf.js';
export const certificateKeys=['recipient.name','award.name','award.cycle','programme.name','category.name','application.reference','issued.date'];
export function postgresBytes(value){
  if(Buffer.isBuffer(value))return value;
  if(typeof value!=='string'||!/^\\x[0-9a-f]*$/i.test(value))throw new Error('Stored PDF bytes unavailable');
  return Buffer.from(value.slice(2),'hex');
}
export async function validateAwardTemplate(bytes,placeholders){
  if(!Array.isArray(placeholders)||placeholders.length>100)throw new Error('Up to 100 text placeholders are supported');
  for(const p of placeholders){
    if(!p||p.field_type==='image'||!certificateKeys.includes(p.placeholder_key))throw new Error('Choose an award text placeholder; signatures belong in the source PDF');
  }
  await inspectPdf(bytes);
  await renderCpdCertificatePdf(bytes,placeholders,Object.fromEntries(certificateKeys.map(key=>[key,'Sample'])));
}
export async function awardCertificateContext(db,tenantId,outcomeId,recipientName){
  const result=await db.from('awards_outcome_revision').select('id,award_id,application_id,state,category_snapshot,revision')
    .eq('tenant_id',tenantId).eq('id',outcomeId).single();
  if(result.error||!result.data)throw new Error('Outcome unavailable');
  const outcome=result.data;
  if(outcome.state!=='approved'||outcome.category_snapshot?.certificate_enabled!==true)throw new Error('An approved certificate-enabled outcome is required');
  const application=await db.from('awards_application').select('id,reference,member_id,submission_id')
    .eq('tenant_id',tenantId).eq('id',outcome.application_id).single();
  const award=await db.from('awards_competition').select('id,name,cycle,programme_id')
    .eq('tenant_id',tenantId).eq('id',outcome.award_id).single();
  if(application.error||award.error)throw application.error||award.error;
  let name=recipientName,programme='';
  if(application.data.member_id){
    const member=await db.from('member').select('first_name,last_name').eq('id',application.data.member_id).single();
    if(member.error)throw member.error;
    name=[member.data.first_name,member.data.last_name].filter(Boolean).join(' ');
  }
  if(typeof name!=='string'||!name.trim()||name.length>300)throw new Error('Enter the external recipient’s approved certificate name');
  if(award.data.programme_id){
    const p=await db.from('awards_programme').select('name').eq('tenant_id',tenantId).eq('id',award.data.programme_id).single();
    if(p.error)throw p.error;programme=p.data.name;
  }
  return{outcome,recipient:{name,member_id:application.data.member_id||null},
    values:{'recipient.name':name,'award.name':award.data.name,'award.cycle':award.data.cycle||'',
      'programme.name':programme,'category.name':outcome.category_snapshot.name,'application.reference':application.data.reference,
      'issued.date':new Date().toISOString().slice(0,10)}};
}
