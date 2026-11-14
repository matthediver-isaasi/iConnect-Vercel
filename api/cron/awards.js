import {timingSafeEqual} from 'node:crypto';
import {supabase} from '../_lib/database.js';
import {deliverAwardsInvitations} from '../_lib/assessment/invitationDelivery.js';
import {deliverAwardMessages} from '../_lib/assessment/messageDelivery.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','no-store');
  const secret=dependencies.cronSecret||process.env.CRON_SECRET;
  const actual=Buffer.from(String(req.headers?.authorization||'')),expected=Buffer.from(`Bearer ${secret||''}`);
  if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;
  if(!db)return res.status(503).json({error:'Awards delivery unavailable'});
  try{
    const options={...dependencies,deadline:Date.now()+45000};
    const scheduling=await db.rpc('awards_schedule_automatic_messages',{p_limit:5});
    if(scheduling.error)throw scheduling.error;
    const invitations=await deliverAwardsInvitations(db,options);
    const messages=Date.now()<options.deadline-10000?await deliverAwardMessages(db,options):[];
    return res.json({scheduling:scheduling.data,outcomes:[...invitations,...messages]});
  }
  catch{return res.status(503).json({error:'Awards delivery could not be processed'});}
}
