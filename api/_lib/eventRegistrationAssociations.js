import {assertPublicTicketRole, PublicTicketMemberError} from './publicTicketMemberCreation.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,status=400)=>{throw new PublicTicketMemberError('REGISTRATION_ASSOCIATION',message,status);};
export const hasRegistrationAssociation=(purchaser,items=[])=>[purchaser,...items.flatMap(i=>i.attendees||[])]
  .some(p=>p?.registration_association!=null);
export function normalizeRegistrationAssociationConfig(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))fail('Invalid registration organisation settings.');
  const result={role_id:value.role_id||null};
  for(const key of ['organizations','groups']){
    const entry=value[key]||{};
    if(entry.field_id&&!uuid.test(entry.field_id))fail('Choose a valid custom field.');
    if(entry.field_id&&(typeof entry.value!=='string'||!entry.value.trim()||entry.value.length>1000))fail('Enter a custom-field filter value.');
    result[key]={enabled:entry.enabled===true,field_id:entry.field_id||null,value:entry.field_id?entry.value:''};
  }
  if((result.organizations.enabled||result.groups.enabled)&&!uuid.test(result.role_id||''))fail('Choose a role for new accounts.');
  return result;
}
export async function validateRegistrationAssociationConfig(db,tenantId,value,authorized){
  const config=normalizeRegistrationAssociationConfig(value);
  if(!config||(!config.organizations.enabled&&!config.groups.enabled))return config;
  if(!authorized)fail('Role-management administrator access is required to configure registration accounts.',403);
  const role=await db.from('role').select('*').eq('id',config.role_id).eq('tenant_id',tenantId).maybeSingle();
  if(role.error)fail('Unable to verify the new-account role.',503);
  assertPublicTicketRole(role.data,tenantId);
  for(const [key,scope] of [['organizations','organization'],['groups','organization_group']]){
    if(!config[key].enabled||!config[key].field_id)continue;
    const field=await db.from('preference_field').select('id,entity_scope').eq('tenant_id',tenantId).eq('id',config[key].field_id).maybeSingle();
    if(field.error||!field.data||field.data.entity_scope!==scope)fail('The selected filter field does not belong to this record type.');
  }
  return config;
}
export async function registrationAssociationOptions(db,{tenantId,eventId,eventKind,q='',kind=null,id=null}){
  if(!uuid.test(eventId||'')||!['simple','complex'].includes(eventKind))fail('Invalid event.');
  const result=await db.rpc('event_registration_association_options',{
    p_tenant:tenantId,p_event:eventId,p_complex:eventKind==='complex',
    p_query:String(q).slice(0,150),p_kind:kind,p_id:id,
  });
  if(result.error)fail('Organisation choices are unavailable. Please try again.',503);
  return result.data;
}
export async function resolveRegistrationAssociations({db,tenantId,eventId,eventKind,purchaser,items,authenticatedMember}){
  if(!hasRegistrationAssociation(purchaser,items))return null;
  if(authenticatedMember?.tenant_id===tenantId)return null;
  const {data:event,error}=await db.from(eventKind==='complex'?'complex_event':'event')
    .select('registration_association_config').eq('id',eventId).eq('tenant_id',tenantId).maybeSingle();
  if(error||!event)fail('Unable to verify event registration settings.',503);
  const config=normalizeRegistrationAssociationConfig(event.registration_association_config);
  if(!config)fail('Organisation selection is not enabled for this event.');
  const role=await db.from('role').select('*').eq('tenant_id',tenantId).eq('id',config.role_id).maybeSingle();
  if(role.error)fail('Unable to verify the new-account role.',503);
  assertPublicTicketRole(role.data,tenantId);
  const approved=new Map();
  for(const person of [purchaser,...items.flatMap(i=>i.attendees||[])]){
    const selection=person?.registration_association;
    if(selection==null)continue;
    if(!['organization','group'].includes(selection.kind)||!uuid.test(selection.id||''))fail('Choose an organisation or group from the list.');
    const key=`${selection.kind}:${selection.id}`;
    if(!approved.has(key)){
      const options=await registrationAssociationOptions(db,{tenantId,eventId,eventKind,kind:selection.kind,id:selection.id});
      const found=options?.options?.find(o=>o.id===selection.id&&o.kind===selection.kind);
      if(!found)fail('The selected organisation or group is no longer available. Please choose again.',409);
      approved.set(key,{kind:selection.kind,id:selection.id,name:found.name});
    }
  }
  const resolve=person=>{
    if(!person)return person;
    const selection=person.registration_association;
    const canonical=selection?approved.get(`${selection.kind}:${selection.id}`):null;
    const {registration_association:ignored,...rest}=person;
    return canonical?{...rest,organization:canonical.name,registration_association:canonical}:rest;
  };
  return {purchaser:resolve(purchaser),items:items.map(i=>({...i,attendees:i.attendees.map(resolve)})),role:role.data};
}
