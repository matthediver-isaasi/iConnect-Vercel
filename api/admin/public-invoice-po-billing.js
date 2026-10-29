import {supabase} from '../_lib/database.js';
import {getTenantContext,hasAdminAccess,hasFeatureAccess} from '../_lib/tenantContext.js';
import {registrationMemberInput} from '../_lib/eventRegistrationMember.js';
import {loadPublicPoBilling,generatePublicPoInvoice} from '../_lib/publicInvoicePoBilling.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 try{
  const ctx=await getTenantContext(req);
  if(!ctx?.isAuthenticated||!ctx?.tenantId||ctx.tenantMismatch||!await hasAdminAccess(ctx))return res.status(403).json({error:'Administrator access required.'});
  if(ctx.roleId&&!await hasFeatureAccess(ctx.roleId,'events.event-report',ctx.memberExcludedFeatures))return res.status(403).json({error:'Event registration report access required.'});
  const raw=req.method==='POST'?req.body:req.query;
  const input=registrationMemberInput(raw);
  const result=req.method==='POST'
    ?await generatePublicPoInvoice(supabase,ctx.tenantId,ctx.memberId||ctx.userId||ctx.user?.id||ctx.tenantUserId,{...input,fingerprint:raw.fingerprint})
    :(await loadPublicPoBilling(supabase,ctx.tenantId,input.bookingId,input.isComplex)).public;
  return res.json(result);
 }catch(error){return res.status(error.status||500).json({error:error.status?error.message:'Unable to process this invoice.'});}
}
