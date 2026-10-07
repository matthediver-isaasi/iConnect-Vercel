import { supabase } from '../_lib/database.js';
import { deliverFormAlerts } from '../_lib/formAlertDelivery.js';
import { FORM_ALERTS_RELEASE_READY } from '../_lib/formAlertReleaseGate.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  if(!process.env.CRON_SECRET) return res.status(503).json({error:'Cron authentication is not configured'});
  if(req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({error:'Unauthorized'});
  if(!FORM_ALERTS_RELEASE_READY) return res.status(503).json({error:'Submission alerts have not passed release verification'});
  try {
    const outcomes=await deliverFormAlerts(supabase);
    return res.status(200).json({processed:outcomes.length,attention:outcomes.filter(row=>row.status==='attention').length});
  } catch {
    return res.status(503).json({error:'Alert delivery requires retry or administrator review'});
  }
}
