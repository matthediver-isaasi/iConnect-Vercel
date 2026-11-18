// One-off operational runner. No handlers, financial jobs, Xero writes or token refresh.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT, COMPANY, hash, planAudit, scanContacts, pick } from './lib/bnms-member-invoice-audit.mjs';
import { snapshot, writeCandidate } from './bnms-member-invoice-audit-db.mjs';
import { createXeroRateLimitedFetch, XERO_LIMIT_HEADERS } from '../api/_lib/xeroRateLimit.js';

const args=process.argv.slice(2), mode=args[0], dir=args[1];
assert.ok(['--discover','--plan','--apply'].includes(mode),'Explicit mode required');
assert.equal(args.length,mode==='--apply'?3:2);
assert.match(dir||'',/^generated-artifacts\/bnms-member-invoice-audit-[a-zA-Z0-9-]+$/);
for (const command of [['check-ignore','-q',`${dir}/snapshot.json`],['check-ignore','-q',`${dir}/audit.xlsx`]]) execFileSync('git',command);
await mkdir(dir,{recursive:true,mode:0o700});
const save=async(name,value)=>writeFile(`${dir}/${name}`,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
const load=async name=>JSON.parse(await readFile(`${dir}/${name}`,'utf8'));
const db=await connectDestination();
const journal = async value => appendFile(`${dir}/receipts.jsonl`,JSON.stringify(value)+'\n',{mode:0o600});
let committed=false;

async function discover(label) {
  const report={startedAt:new Date().toISOString(),requests:[],complete:false,contacts:[],pages:[]};
  const token=async()=> {
    const rows=(await db.query('select id,tenant_id,access_token,expires_at from xero_token where app_tenant_id=$1',[TENANT])).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].tenant_id,COMPANY);
    assert.ok(Date.parse(rows[0].expires_at)>Date.now()+60000,'Xero access token expired/near expiry; no refresh attempted');
    return rows[0];
  };
  try {
    const integrations=(await db.query("select credentials,is_enabled from tenant_integrations where tenant_id=$1 and integration_type='xero'",[TENANT])).rows;
    assert.equal(integrations.length,1); assert.equal(integrations[0].is_enabled,true);
    let id=integrations[0].credentials?.client_id;
    assert.ok(typeof id==='string' && id);
    if(id.includes(':')) {
      const [iv,encrypted]=id.split(':');
      const key=process.env.INTEGRATION_ENCRYPTION_KEY||process.env.SESSION_SECRET;
      assert.ok(key,'Credential decryption prerequisite unavailable');
      const decipher=createDecipheriv('aes-256-cbc',scryptSync(key,'salt',32),Buffer.from(iv,'hex'));
      id=decipher.update(encrypted,'hex','utf8')+decipher.final('utf8');
    }
    const appKey=hashClientId(id);
    const adapter={rpc:async(name,a)=>{
      const result=name==='xero_rate_reserve'
        ? await db.query('select public.xero_rate_reserve($1,$2) data',[a.p_app,a.p_company])
        : await db.query('select public.xero_rate_finish($1,$2,$3,$4,$5,$6) data',[a.p_app,a.p_company,a.p_id,a.p_status,a.p_headers,a.p_retry]);
      return {data:result.rows[0].data,error:null};
    }};
    const limited=createXeroRateLimitedFetch({resolve:async()=>({db:adapter,appKey,companyId:COMPANY})});
    const get=async(path,raw=false)=>{
      assert.ok(path==='Organisation'||path==='/connections'||/^Contacts\?includeArchived=true&page=\d+&pageSize=100&order=ContactID$/.test(path),'Forbidden Xero endpoint');
      assert.ok(report.requests.length<205,'Request budget exhausted');
      if(report.requests.length) await new Promise(r=>setTimeout(r,1600));
      const t=await token();
      const response=await limited(path==='/connections'?'https://api.xero.com/connections':`https://api.xero.com/api.xro/2.0/${path}`,{
        method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:`Bearer ${t.access_token}`,'xero-tenant-id':COMPANY,Accept:'application/json'},
      });
      report.requests.push({path,status:response.status,at:new Date().toISOString(),
        quota:Object.fromEntries(XERO_LIMIT_HEADERS.map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null))});
      assert.ok(response.ok,`Xero GET stopped HTTP ${response.status}; no retry`);
      const body=await response.json();
      assert.ok(!body?.ErrorNumber&&!body?.HasErrors,'Xero returned provider error');
      // Durable raw response evidence; never log contact data.
      await save(`${label}-response-${report.requests.length}.json`,body);
      return body;
    };
    report.connections=await get('/connections');
    assert.ok(Array.isArray(report.connections) && report.connections.some(c=>c.tenantId===COMPANY),'Selected Xero connection not present');
    report.organisation=(await get('Organisation')).Organisations;
    assert.equal(report.organisation?.length,1);
    assert.equal(report.organisation[0].OrganisationID,COMPANY);
    assert.match(report.organisation[0].Name,/BNMS|British Nuclear Medicine/i);
    Object.assign(report,await scanContacts(get));
  } catch(error) {
    report.error=error.message;
  }
  await save(`${label}.json`,report);
  console.log(JSON.stringify({stage:label,complete:report.complete,requests:report.requests.length,contacts:report.contacts.length,error:report.error}));
  return report;
}
// Same digest as shared quota identity (raw client ID never leaves memory).
function hashClientId(id) {
  return createHash('sha256').update(id.trim().toLowerCase()).digest('hex');
}
import { createHash } from 'node:crypto';

try {
  if(mode==='--discover') {
    await db.query('begin isolation level repeatable read read only');
    const s=await snapshot(db);
    await db.query('rollback');
    await save('snapshot.json',s);
    await save('snapshot-pin.json',{sha256:hash(s),at:s.capturedAt});
    console.log(JSON.stringify({stage:'cohort',total:s.total,excluded:s.excludedCount,eligible:s.total-s.excludedCount,pagination:s.pagination}));
    await discover('discovery');
  } else if(mode==='--plan') {
    const s=await load('snapshot.json'), discovery=await load('discovery.json');
    assert.equal(hash(s),(await load('snapshot-pin.json')).sha256);
    const rows=planAudit(s,discovery);
    const manifest={snapshotHash:hash(s),discoveryHash:hash(discovery),createdAt:new Date().toISOString(),rows};
    await save('manifest.json',manifest);
    const counts=rows.reduce((a,r)=>(a[r.outcome]=(a[r.outcome]||0)+1,a),{});
    await save('manifest-pin.json',{sha256:hash(manifest),counts,candidates:rows.filter(r=>r.candidate).length});
    console.log(JSON.stringify({stage:'dry-run',complete:discovery.complete,counts,candidates:rows.filter(r=>r.candidate).length,manifestSha256:hash(manifest)}));
  } else {
    const manifest=await load('manifest.json'), pin=await load('manifest-pin.json'), original=await load('snapshot.json');
    assert.equal(hash(manifest),args[2],'Explicit manifest SHA256 pin required');
    assert.equal(hash(manifest),pin.sha256); assert.equal(hash(original),manifest.snapshotHash);
    assert.ok((await load('discovery.json')).complete,'Incomplete discovery cannot authorize writes');
    await writeFile(`${dir}/receipts.jsonl`,'',{mode:0o600,flag:'wx'});
    const source=await discover('fresh-source');
    assert.ok(source.complete,'Fresh source discovery incomplete');
    await db.query('begin isolation level serializable');
    await db.query("set local lock_timeout='8s'");
    await db.query("set local statement_timeout='60s'");
    // Row locks block identity, tenancy and primary role edits for this cohort.
    // If secondary assignments exist, lock that relation against inserts as well.
    await db.query('select id from member where tenant_id=$1 order by id for share',[TENANT]);
    await db.query('select id from role where tenant_id=$1 order by id for share',[TENANT]);
    if(original.secondary.length || original.relations.some(r=>r.table_name==='member_role')) await db.query('lock table member_role in share mode');
    await db.query('select id from xero_token where app_tenant_id=$1 for share',[TENANT]);
    await db.query("select id from tenant_integrations where tenant_id=$1 and integration_type='xero' for share",[TENANT]);
    const current=await snapshot(db);
    assert.equal(current.guestRole.id,original.guestRole.id);
    assert.equal(current.connection.id,original.connection.id);
    const freshRows=planAudit(current,source), freshMap=new Map(freshRows.map(r=>[r.member.id,r]));
    const receipts=[];
    await journal({stage:'started',manifestHash:pin.sha256,sourceHash:hash(source),at:new Date().toISOString()});
    await save('pre-write.json',current);
    for(const row of manifest.rows.filter(r=>r.candidate)) {
      const saved=freshMap.get(row.member.id);
      if(!saved?.candidate || hash(saved.contact)!==hash(row.contact) || hash(saved.proposed)!==hash(row.proposed)) {
        const receipt={id:row.member.id,outcome:'skipped source/eligibility/target changed'};
        receipts.push(receipt); await journal(receipt); continue;
      }
      const receipt=await writeCandidate(db,row,current,saved);
      receipts.push(receipt); await journal(receipt);
    }
    const after=await snapshot(db);
    assert.deepEqual(after.members,current.members,'Member/membership/mailing fields changed');
    assert.deepEqual(after.roles,current.roles);
    assert.deepEqual(after.secondary,current.secondary);
    assert.deepEqual(after.links,current.links);
    const changed=new Set(receipts.filter(r=>r.outcome==='copied').map(r=>r.id));
    for(const old of current.addresses) if(old.owner_type!=='member'||!changed.has(old.owner_id)) {
      assert.deepEqual(after.addresses.find(a=>a.owner_type===old.owner_type&&a.owner_id===old.owner_id),old,'Protected target changed');
    }
    assert.equal(after.addresses.length,current.addresses.length+receipts.filter(r=>r.outcome==='copied'&&!r.before).length);
    for(const receipt of receipts.filter(r=>r.outcome==='copied')) assert.deepEqual(
      pick(after.addresses.find(a=>a.owner_type==='member'&&a.owner_id===receipt.id)),pick(receipt.after));
    const rerun=planAudit(after,source).filter(r=>r.candidate&&changed.has(r.member.id));
    assert.equal(rerun.length,0,'Copied records must be ineligible on rerun');
    await db.query('commit'); committed=true;
    await journal({stage:'committed',at:new Date().toISOString(),count:changed.size});
    await db.query('begin isolation level repeatable read read only');
    const verified=await snapshot(db);
    for(const receipt of receipts.filter(r=>r.outcome==='copied')) assert.deepEqual(
      pick(verified.addresses.find(a=>a.owner_type==='member'&&a.owner_id===receipt.id)),pick(receipt.after));
    await db.query('rollback');
    await save('final-snapshot.json',verified);
    const replay=planAudit(verified,source);
    await save('verification.json',{committed:true,verified:true,copied:changed.size,receipts,
      protectedTargetsVerified:true,memberRecordsUnchanged:true,at:new Date().toISOString(),
      zeroWriteRerunCandidates:replay.filter(r=>r.candidate).length,zeroWriteRerunHash:hash(replay),
      concurrentCohortChange:original.total!==verified.total,
      finalSnapshotHash:hash(verified)});
    console.log(JSON.stringify({stage:'verified',copied:changed.size,skipped:receipts.length-changed.size,zeroWriteRerunCandidates:replay.filter(r=>r.candidate).length}));
  }
} catch(error) {
  await db.query('rollback').catch(()=>{});
  if(mode==='--apply') await journal({stage:committed?'post-commit-error':'rolled-back',error:error.message});
  else await appendFile(`${dir}/operational-errors.jsonl`,JSON.stringify({at:new Date().toISOString(),mode,error:error.message})+'\n',{mode:0o600});
  // Assertion messages can contain before/after PII. Keep details private.
  console.error(JSON.stringify({stage:'stopped',committed,errorCode:error.code||error.name,
    detail:'Inspect the private evidence journal; no member details are printed.'}));
  process.exitCode=1;
} finally { await db.end(); }
