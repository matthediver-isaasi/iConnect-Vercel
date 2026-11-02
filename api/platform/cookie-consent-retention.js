import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';
export default async function handler(req,res) {
  if (req.method!=='POST') return res.status(405).end();
  if (!await getSessionPlatformOwner(req)) return res.status(403).end();
  try {
    if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).end();
    const {data,error}=await supabase.rpc('cleanup_cookie_consent');
    if (error) throw error;
    return res.json({deleted:data,batchLimit:1000});
  } catch { return res.status(503).json({error:'Retention cleanup unavailable'}); }
}
