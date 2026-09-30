// Private, destination-scoped GET journal. A cached response retains its actual
// observation time; discovery completion is NOT permission to release.
import {mkdir,open,readFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const ALPHA_INVOICE_START='2026-01-01';
export const ALPHA_INVOICE_WHERE='Date>=DateTime(2026,1,1)';
export function alphaInvoiceQuery(contactIds,page){
  // Xero Accounting GET /Invoices supports where, ContactIDs, order and page.
  // Date is the invoice date, NOT UpdatedDateUTC or a creation timestamp.
  return {ContactIDs:contactIds.join(','),page:String(page),where:ALPHA_INVOICE_WHERE,order:'InvoiceID ASC'};
}
export const DEFAULT_ALPHA_CHECKPOINT='exports/private-bnms-alpha-readiness/checkpoint.json';
export const PREVIOUS_ALPHA_RATE_LIMIT='exports/private-bnms-alpha-attestation-20260920/readiness-retry-1QbDYF/rate-limit.json';
const age=15*60*1000;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw Error(message);};

export function alphaRetryNotBefore(diagnostic){
  if(diagnostic?.status!==429||!['Xero','GoCardless'].includes(diagnostic.provider)
    ||!Number.isFinite(Date.parse(diagnostic.observedAt)))fail('Invalid saved alpha rate-limit diagnostic');
  const retry=diagnostic.retryAfter;
  if(!retry||retry.format==='discarded-invalid')return null;
  const value=retry.format==='numeric'&&/^\d+$/.test(retry.value)
    ? Date.parse(diagnostic.observedAt)+Number(retry.value)*1000
    : retry.format==='http-date'?Date.parse(retry.value):NaN;
  if(!Number.isFinite(value)||value<0||value>8.64e15)fail('Invalid saved alpha Retry-After');
  return new Date(value).toISOString();
}

export async function openAlphaCheckpoint(file,scope,{now=()=>new Date(),seedRateLimit}={}){
  const path=resolve(file),root=resolve('exports'),parent=dirname(path);
  if(!path.startsWith(root+'/')||parent===root)fail('Alpha checkpoint requires a dedicated private exports directory');
  await mkdir(parent,{recursive:true,mode:0o700});
  if(await realpath(parent)!==parent)fail('Alpha checkpoint symlink directory forbidden');
  const directory=await lstat(parent);
  if(!directory.isDirectory()||(directory.mode&0o077))fail('Alpha checkpoint directory must have mode 0700');
  const lock=await open(path+'.lock','wx',0o600).catch(()=>fail('Alpha checkpoint is locked; verify no scan is running before recovering a crashed lock'));
  let state;
  const stats={reused:0,fetched:0,invalidated:0};
  let oldest=null;
  const save=async()=>{
    const temp=path+'.'+randomUUID()+'.tmp';
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({state,sha256:digest(state)}));await handle.sync();}
    finally{await handle.close();}
    await rename(temp,path);
    const dir=await open(parent,'r');try{await dir.sync();}finally{await dir.close();}
  };
  const close=async()=>{await lock.close();await unlink(path+'.lock');};
  try{
    try{
      const info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))fail('Alpha checkpoint must be a private regular file');
      const saved=JSON.parse(await readFile(path,'utf8'));
      state=saved.state;
      if(!state||saved.sha256!==digest(state)||state.version!==1||state.scopeHash!==digest(scope)
        ||!['discovery','revalidation'].includes(state.phase)||!state.entries||Array.isArray(state.entries)
        ||typeof state.entries!=='object')fail('Corrupt or scope-mismatched alpha checkpoint');
      for(const [key,entry] of Object.entries(state.entries)){
        if(!/^[a-f0-9]{64}$/.test(key)||!/^[a-f0-9]{64}$/.test(entry.group||'')
          ||!Number.isFinite(Date.parse(entry.observedAt))||Date.parse(entry.observedAt)>now().getTime()
          ||!entry.body||typeof entry.body!=='object')fail('Invalid alpha checkpoint response');
      }
      if(state.rateLimit){
        if(state.notBefore!==alphaRetryNotBefore(state.rateLimit))fail('Invalid alpha checkpoint retry deadline');
      }else if(state.notBefore!==null)fail('Invalid alpha checkpoint retry state');
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      state={version:1,scopeHash:digest(scope),phase:'discovery',entries:{},rateLimit:null,notBefore:null};
    }
    if(seedRateLimit){
      const deadline=alphaRetryNotBefore(seedRateLimit);
      if(!state.rateLimit||(Date.parse(seedRateLimit.observedAt)>Date.parse(state.rateLimit.observedAt)
        &&(!deadline||(state.notBefore&&deadline>state.notBefore)))){
        state.rateLimit=seedRateLimit;state.notBefore=deadline;
      }
    }
    await save();
    const assertAllowed=()=>{
      if(state.rateLimit&&!state.notBefore)fail('Provider rate limit has no Retry-After; explicit operator review required');
      if(state.notBefore&&now().getTime()<Date.parse(state.notBefore)){
        const error=Error(`Alpha provider retry prohibited until ${state.notBefore}`);
        error.rateLimitDiagnostic=state.rateLimit;throw error;
      }
    };
    return {
      close,assertAllowed,stats,
      async recordRateLimit(diagnostic){
        state.rateLimit=diagnostic;state.notBefore=alphaRetryNotBefore(diagnostic);await save();
      },
      async bindCredentials(binding,{forceFresh=false}={}){
        const next=digest(binding);
        // OAuth rotation is legitimate, but none of the previous credential
        // generation's responses may authorize the new generation.
        if(forceFresh||state.credentialBinding!==next){
          stats.invalidated+=Object.keys(state.entries).length;
          state.entries={};
          if(forceFresh||state.credentialBinding)state.phase='revalidation';
          state.credentialBinding=next;oldest=null;await save();
        }
      },
      get progress(){return {phase:state.phase,savedResponses:Object.keys(state.entries).length,
        notBefore:state.notBefore,...stats};},
      get oldestObservedAt(){return oldest;},
      get phase(){return state.phase;},
      async revalidate(){state.phase='revalidation';oldest=null;await save();},
      wrap(transport){
        return async(url,options)=>{
          assertAllowed();
          const target=new URL(url);
          if(options?.method!=='GET'||target.protocol!=='https:'||target.username||target.password
            ||!['api.xero.com','api.gocardless.com'].includes(target.hostname))
            fail('Checkpoint permits pinned provider GET requests only');
          target.searchParams.sort();
          const key=digest(target.href),groupUrl=new URL(target);
          groupUrl.searchParams.delete('page');groupUrl.searchParams.delete('after');
          const group=digest(groupUrl.href);
          // Offset/cursor pages form a single observation generation. Refresh
          // the WHOLE list, never combine an old first page with a new tail.
          if(state.phase==='revalidation'&&Object.values(state.entries).some(e=>
            e.group===group&&now().getTime()-Date.parse(e.observedAt)>=age)){
            for(const [id,entry]of Object.entries(state.entries))if(entry.group===group){delete state.entries[id];stats.invalidated++;}
            await save();
          }
          let entry=state.entries[key];
          if(entry)stats.reused++;
          else{
            const observedAt=now().toISOString();
            try{
              const response=await transport(url,options);
              if(!response.ok)fail('Checkpoint requires successful bounded provider transport');
              const body=await response.json();
              if(!body||typeof body!=='object')fail('Invalid alpha provider JSON response');
              entry={group,observedAt,body};
              state.entries[key]=entry;stats.fetched++;
              await save();
            }catch(error){
              if(error.rateLimitDiagnostic){
                state.rateLimit=error.rateLimitDiagnostic;
                state.notBefore=alphaRetryNotBefore(state.rateLimit);
                await save();
              }
              throw error;
            }
          }
          if(!oldest||entry.observedAt<oldest)oldest=entry.observedAt;
          return {ok:true,status:200,json:async()=>structuredClone(entry.body)};
        };
      },
    };
  }catch(error){await close();throw error;}
}

export async function readAlphaRateLimitSeed(path=PREVIOUS_ALPHA_RATE_LIMIT){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

// Preflight uses this before even refreshing OAuth. The scan itself repeats
// the check under its exclusive lock and validates the full destination scope.
export async function assertAlphaCheckpointRetryAllowed(file=DEFAULT_ALPHA_CHECKPOINT,{now=()=>new Date(),seedRateLimit}={}){
  const diagnostics=[seedRateLimit??await readAlphaRateLimitSeed()];
  try{
    const saved=JSON.parse(await readFile(resolve(file),'utf8'));
    if(!saved.state||saved.sha256!==digest(saved.state))fail('Corrupt alpha checkpoint');
    diagnostics.push(saved.state.rateLimit);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  for(const diagnostic of diagnostics.filter(Boolean)){
    const deadline=alphaRetryNotBefore(diagnostic);
    if(!deadline)fail('Provider rate limit has no Retry-After; explicit operator review required');
    if(now().getTime()<Date.parse(deadline))fail(`Alpha provider retry prohibited until ${deadline}`);
  }
}