import { createClient } from '@supabase/supabase-js';
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
const c=await db.from('campaign').select('*').ilike('name','%Heads - LC27%');
if(c.error){console.log(c.error);process.exit()}
for(const r of c.data){const o={};for(const k of Object.keys(r)){if(!/html|content|body|design/i.test(k))o[k]=r[k]};console.log(JSON.stringify(o,null,1))}
for(const r of c.data){const p=await db.from('campaign_preparation').select('*').eq('campaign_id',r.id);console.log('prep',JSON.stringify(p.error||p.data?.map(x=>{const o={...x};delete o.snapshot;return o}),null,1))}
