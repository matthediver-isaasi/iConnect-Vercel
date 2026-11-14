import http from 'node:http';
import {spawn} from 'node:child_process';
import {writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
const secret='awards-local-only-not-valid-outside-tests';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startAwardsPostgrest(root,port){
  if(process.env.TEST_ISOLATION_ALLOW_LOCAL_POSTGREST!=='1')throw new Error('Use --allow-local-postgrest --allow-local-postgres for real HTTP tests');
  const socket=join(root,'postgrest.sock'),config=join(root,'postgrest.conf');
  const values={'db-uri':`postgresql:///postgres?host=${encodeURIComponent(root)}&port=${port}&user=postgres`,
    'db-anon-role':'anon','db-schemas':'public','jwt-secret':secret,'server-unix-socket':socket,'server-unix-socket-mode':'600','db-pool':1};
  await writeFile(config,Object.entries(values).map(([key,value])=>`${key} = ${JSON.stringify(value)}`).join('\n'),{mode:0o600});
  const child=spawn('postgrest',[config],{stdio:['ignore','ignore','pipe']});let failure='',spawnError;
  child.stderr.on('data',chunk=>{failure=(failure+chunk).slice(-2000);});child.on('error',error=>{spawnError=error;});
  const stop=async()=>{if(child.exitCode!==null||spawnError)return;child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));};
  try{
    for(let attempt=0;;attempt++){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null)throw new Error(`Local PostgREST stopped: ${failure}`);
      if(await stat(socket).then(file=>file.isSocket(),()=>false))break;
      if(attempt>=100)throw new Error('Local PostgREST did not open its owned socket');
      await delay(50);
    }
    const unixFetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url||input.toString());
      if(url.origin!=='http://awards-fixture.invalid')throw new Error('Non-fixture URL refused');
      return new Promise((resolve,reject)=>{
        const request=http.request({socketPath:socket,agent:false,method:options.method||'GET',
          path:url.pathname.replace(/^\/rest\/v1(?=\/)/,'')+url.search,headers:Object.fromEntries(new Headers(options.headers))},response=>{
          const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
          response.on('end',()=>resolve(new Response(response.statusCode===204?null:Buffer.concat(chunks),{
            status:response.statusCode,headers:response.headers})));
        });
        request.on('error',reject);request.end(options.body);
      });
    };
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned=`${encode({alg:'HS256',typ:'JWT'})}.${encode({role:'service_role',exp:Math.floor(Date.now()/1000)+3600})}`;
    const token=`${unsigned}.${createHmac('sha256',secret).update(unsigned).digest('base64url')}`;
    const client=createClient('http://awards-fixture.invalid',token,{global:{fetch:unixFetch},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    // The socket can open before the initial schema cache is ready.
    for(let attempt=0;attempt<100;attempt++){
      const probe=await client.from('tenant').select('id').limit(1);
      if(!probe.error)return{client,stop};
      if(probe.error.code!=='PGRST002')throw new Error(`Local HTTP schema unavailable: ${JSON.stringify(probe.error)}`);
      await delay(50);
    }
    throw new Error('Local HTTP schema cache did not become ready');
  }catch(error){await stop();throw error;}
}
