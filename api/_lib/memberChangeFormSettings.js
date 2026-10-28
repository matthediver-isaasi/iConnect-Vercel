import {amendmentResult} from './memberAmendmentSettlement.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export function createMemberChangeFormSettings({db}){
 async function read(tenantId,formId){
  if(!uuid.test(formId||''))fail('A saved form is required.',400);
  const form=amendmentResult(await db.from('form').select('id,require_authentication,is_active')
   .eq('tenant_id',tenantId).eq('id',formId).maybeSingle());
  if(!form)fail('Form not found.',404);
  const saved=amendmentResult(await db.from('membership_change_form').select('*')
   .eq('tenant_id',tenantId).eq('form_id',formId).maybeSingle());
  const options=[];
  for(let offset=0;;offset+=250){
   const rows=amendmentResult(await db.from('membership_tier_config').select('id,name')
    .eq('tenant_id',tenantId).eq('structure_scope_type','member').eq('is_active',true)
    .order('id').range(offset,offset+249));
   if(!Array.isArray(rows)||options.length+rows.length>1000)fail('Membership structure list could not be loaded completely.',503);
   options.push(...rows);if(rows.length<250)break;
  }
  return {formId,enabled:saved?.enabled===true,targetConfigIds:saved?.target_config_ids||[],
   revision:saved?.revision||0,targetOptions:options,requiresAuthentication:form.require_authentication===true,
   formActive:form.is_active===true,executionEnabled:false};
 }
 async function save(tenantId,actorId,input){
  const {formId,revision,enabled,targetConfigIds}=input||{};
  if(!uuid.test(formId||'')||!Number.isSafeInteger(revision)||revision<0||typeof enabled!=='boolean'
   ||!Array.isArray(targetConfigIds)||targetConfigIds.length>100
   ||targetConfigIds.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(targetConfigIds).size!==targetConfigIds.length){
   fail('Valid form settings and their current revision are required.',400);
  }
  const result=await db.rpc('save_membership_change_form',{p_tenant_id:tenantId,p_actor_id:actorId,
   p_form_id:formId,p_revision:revision,p_enabled:enabled,p_targets:targetConfigIds});
  if(result.error)fail(result.error.code==='P0001'?result.error.message:'Membership-change settings could not be saved.',
   result.error.code==='P0001'?(/Reload before saving/.test(result.error.message)?409:422):503);
  return read(tenantId,formId);
 }
 return {read,save};
}
