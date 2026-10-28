import {createMemberAmendmentsService,AMENDMENT_UUID} from './memberAmendments.js';
import {createMemberChangeAuthorityResolver} from './memberChangeAuthorityResolver.js';
import {createMemberChangeAuthorityService} from './memberChangeAuthority.js';
import {resolveFormAccess} from './formAccessPolicy.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {amendmentResult} from './memberAmendmentSettlement.js';
import {attachMemberRequestProgress} from './memberChangeRequestProgress.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const keyValid=key=>typeof key==='string'&&/^[A-Za-z0-9_.:-]{8,128}$/.test(key);
export function memberRequestSummary(authority){
 const c=authority.calculation||{};
 return {targetName:authority.targetSnapshot?.name||'Membership structure',
  currency:c.currency,paymentDueMinor:c.paymentDueMinor,
  surplusMinor:authority.settlement?.surplusEligibleMinor??(c.surplusMinor===0?0:undefined),
  effectiveDate:c.effectiveDate,renewalDate:c.membershipEndExclusiveDate||c.newTerm?.renewalDate,
  monthlyAmountMinor:c.currentMonthlyPriceMinor??authority.monthlyExecution?.providerTarget?.amountMinor,
  reason:authority.request?.reason};
}
export function memberRequestDto(row){
 return {id:row.id,state:row.state,createdAt:row.created_at,reviewReason:row.review_reason,
  authorityId:row.authority_id,summary:memberRequestSummary(row.authority)};
}
export function createMemberChangeRequests({db,amendments=createMemberAmendmentsService({db}),
 access=resolveFormAccess,now=()=>new Date(),resolveAdmin=createMemberChangeAuthorityResolver({db,amendments}),
 resolveMember=null}){
 function check(context){
  if(!AMENDMENT_UUID.test(context.memberId||'')||!context.tenantId||!context.actorId
   ||(context.actorKind==='member'&&context.actorId!==context.memberId))fail('Authenticated member ownership required.',403);
 }
 async function row(table,context,filters){
  let q=db.from(table).select('*').eq('tenant_id',context.tenantId);
  for(const [k,v] of Object.entries(filters))q=q.eq(k,v);
  return amendmentResult(await q.maybeSingle());
 }
 async function form(context){
  check(context);
  if(!AMENDMENT_UUID.test(context.formId||''))fail('A valid membership-change form is required.',400);
  const f=await row('form',context,{id:context.formId});
  if(!f||f.is_active!==true||f.require_authentication!==true
   ||(f.deactivate_at&&(!Number.isFinite(Date.parse(f.deactivate_at))||Date.parse(f.deactivate_at)<=now().getTime()))){
   fail('This membership-change form is unavailable.',403);
  }
  const allowed=await access({supabase:db,req:context.req,tenantId:context.tenantId,policy:f.access_policy});
  if(!allowed.allowed)fail('You do not have access to this form.',403);
  const settings=await row('membership_change_form',context,{form_id:f.id});
  if(settings?.enabled!==true)fail('Membership changes are not enabled for this form.',403);
  return {f,settings};
 }
 const resolver=resolveMember||createMemberChangeAuthorityResolver({db,amendments,
  authorizeMember:async(context,selection)=>{
   const {settings}=await form(context);
   if(!settings.target_config_ids?.includes(selection?.configId))fail('Select a structure offered by this form.',403);
   return {formId:context.formId,revision:settings.revision};
  }});
 const authority=createMemberChangeAuthorityService({db,resolve:resolver});
 function selection(input){
  return {configId:input?.configId,bandId:input?.bandId||null,reason:input?.reason,
   effectiveDate:now().toISOString().slice(0,10),action:'change'};
 }
 async function records(context){
  check(context);const all=[];
  for(let offset=0;;offset+=250){
   const rows=amendmentResult(await db.from('member_change_request').select('*')
    .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).order('id').range(offset,offset+249));
   if(!Array.isArray(rows)||all.length+rows.length>2000)fail('Complete request history could not be loaded.',503);
   all.push(...rows);if(rows.length<250)break;
  }
  return all.sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(memberRequestDto);
 }
 async function contextInfo(context){
  const {f,settings}=await form(context),data=await amendments.list(context.tenantId,context.memberId);
  return {form:{id:f.id,name:f.name},current:data.current?{
   startDate:data.current.term_start_date,renewalDate:data.current.membership_renewal_date,
   paymentFrequency:data.current.commitment_snapshot?.payment_frequency}:null,
   blockers:data.blockers||[],structures:(data.structures||[])
    .filter(c=>settings.target_config_ids.includes(c.id)).map(c=>({id:c.id,name:c.name,
     pricingModel:c.pricing_model,bands:(c.bands||[]).map(b=>({id:b.id,label:b.label||b.name}))})),
   requests:await attachMemberRequestProgress(db,context,await records(context)),requiresReview:true};
 }
 async function availability(context){
  try{await form(context);return {available:true};}
  catch(error){if(error.status===403)return {available:false};throw error;}
 }
 async function preview(context,input){
  const result=await authority.preview(context,selection(input));
  return {summary:memberRequestSummary(result.authority),fingerprint:result.fingerprint,
   requiresReview:true,financiallyApplied:false};
 }
 async function recover(context,key,fingerprint){
  check(context);
  if(!keyValid(key)||!/^[a-f0-9]{64}$/.test(fingerprint||''))fail('A valid request key and fingerprint are required.',400);
  const existing=await row('member_change_request',context,{member_id:context.memberId,request_key:key});
  if(!existing)return null;
  if(existing.form_id!==context.formId||monthlyAmendmentFingerprint(existing.authority)!==fingerprint){
   fail('Request key belongs to different evidence.');
  }
  return memberRequestDto(existing);
 }
 async function submit(context,input){
  const existing=await recover(context,input.key,input.fingerprint);
  if(existing){
   const saved=await row('member_change_request',context,{id:existing.id,member_id:context.memberId});
   const original=saved.authority.request;
   if(original.configId!==input.selection?.configId||(original.bandId||null)!==(input.selection?.bandId||null)
    ||original.reason!==input.selection?.reason?.trim())fail('Request key belongs to a different selection.');
   return existing;
  }
  const fresh=await authority.preview(context,selection(input.selection));
  if(fresh.fingerprint!==input.fingerprint)fail('The membership quote changed. Preview again.');
  const result=await db.rpc('submit_member_change_request',{p_tenant_id:context.tenantId,p_member_id:context.memberId,
   p_form_id:context.formId,p_key:input.key,p_authority:fresh.authority});
  if(result.error)fail('The request could not be confirmed. Recover this request before submitting another.');
  return memberRequestDto(result.data);
 }
 async function review(context,{id,action,reason}){
  check(context);
  if(!AMENDMENT_UUID.test(id||'')||!['approve','reject','withdraw'].includes(action)
   ||typeof reason!=='string'||!reason.trim()||reason.trim().length>2000)fail('A valid request and review reason are required.',400);
  if(action!=='withdraw'&&context.actorKind!=='admin')fail('Finance administrator approval is required.',403);
  const existing=await row('member_change_request',context,{id,member_id:context.memberId});
  if(!existing)fail('Request not found.',404);
  let fresh=null;
  if(action==='approve'&&existing.state==='pending'){
   fresh=await resolveAdmin(context,existing.authority.request);
   const {formBinding,...original}=existing.authority;
   if(monthlyAmendmentFingerprint(original)!==monthlyAmendmentFingerprint(fresh)){
    fail('Financial evidence changed. The member must withdraw this request and submit a fresh preview.');
   }
  }
  const result=await db.rpc('review_member_change_request',{p_tenant_id:context.tenantId,p_member_id:context.memberId,
   p_actor_id:context.actorId,p_id:id,p_action:action,p_reason:reason.trim(),p_authority:fresh});
  if(result.error)fail('Review could not be confirmed. Reload request history before retrying.');
  return memberRequestDto(result.data);
 }
 return {availability,contextInfo,preview,submit,recover,records,review};
}
