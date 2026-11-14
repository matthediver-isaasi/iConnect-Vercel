import {resolveFormAccess} from '../formAccessPolicy.js';
import {isFormScheduleAvailable} from '../formAvailability.js';

// Application ownership and ordinary form access are deliberately independent.
// A capability header is never converted into a member/session here.
export async function amendmentChoiceAccess({db,req,tenantId,formId,resolveAccess=resolveFormAccess}){
  const {data:form,error}=await db.from('form').select('*').eq('tenant_id',tenantId).eq('id',formId).maybeSingle();
  if(error)throw error;
  if(!form||!form.is_active||!isFormScheduleAvailable(form)||form.form_type==='survey')return false;
  const ordinaryRequest={...req,headers:{...req.headers}};
  delete ordinaryRequest.headers['x-awards-applicant'];
  // Never forward an externally supplied award credential as ordinary auth.
  const access=await resolveAccess({supabase:db,req:ordinaryRequest,tenantId,policy:form.access_policy});
  return access?.allowed===true;
}
