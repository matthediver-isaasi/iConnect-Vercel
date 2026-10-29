import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {registrationAssociationOptions} from '../_lib/eventRegistrationAssociations.js';
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const tenant=await resolveTenantFromRequest(req);
    if(!tenant)return res.status(404).json({error:'Event not found'});
    const result=await registrationAssociationOptions(supabase,{tenantId:tenant.id,eventId:req.query.event_id,eventKind:req.query.event_kind,q:req.query.q});
    return res.status(200).json(result);
  }catch(error){return res.status(error.status||503).json({error:error.status?error.message:'Organisation choices are unavailable. Please try again.'});}
}
