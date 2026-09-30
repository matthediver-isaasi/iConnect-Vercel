import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const BASELINE='dpl_6hEq9mdejDLdB9eUukppK419dPWt';
const BASELINE_SHA='83ceae1732fb5b63e7312fe5c0baf438831b31f2';
const GITHUB_REPOSITORY_ID=1104295583;
export const REQUIRED_SOURCES=[
  'api/_lib/bnmsBetaAccounting.js',
  'api/_lib/bnmsAlphaAccounting.js',
  'api/_lib/gocardlessAccounting.js','api/_lib/membershipInstalmentInvoicing.js',
  'api/_lib/xero.js','api/_lib/gocardlessDdRenewals.js','api/_lib/gocardlessDynamicCollections.js',
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const isPinnedGitHubSource=(deployment,commit)=>deployment.gitSource?.type==='github'
  &&deployment.gitSource.repoId===GITHUB_REPOSITORY_ID&&deployment.gitSource.sha===commit;
function assertProofShape(proof){
  if(proof?.version!==1||!/^dpl_[A-Za-z0-9]+$/.test(proof.deploymentId||'')
    ||!/^prj_[A-Za-z0-9]+$/.test(proof.projectId||'')||!/^[a-f0-9]{40}$/.test(proof.commit||'')
    ||!proof.sourceHashes||REQUIRED_SOURCES.some(p=>!proof.sourceHashes[p]))
    throw Error('Complete reviewed deployment/source proof required');
}
export const USER_ATTESTATION_MAX_AGE_MS=15*60*1000;
export function assertUserAttestationFresh(proof,now=new Date()){
  const p=proof?.provenance;
  if(p?.kind!=='user-supplied-local-vercel-attestation'||p.agentLiveVerified!==false
    ||!/^[a-f0-9]{64}$/.test(p.attestationSha256||'')
    ||typeof p.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(p.observedAt)
    &&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}\+00:00$/.test(p.observedAt))
    throw Error('Explicit user-supplied attestation provenance required');
  const age=now.getTime()-Date.parse(p.observedAt);
  if(!Number.isFinite(age)||age<0||age>=USER_ATTESTATION_MAX_AGE_MS)
    throw Error('User-supplied Vercel attestation is future-dated or exceeds 15 minutes');
  const normalized=p.observedAt.replace(/\+00:00$/,'Z').replace(/\.(\d{3})\d*Z$/,'.$1Z');
  if(new Date(p.observedAt).toISOString()!==normalized)
    throw Error('Malformed user attestation timestamp');
}
// Explicit manual handover only: never an automatic fallback from a failed API
// request. The original observation and raw-file digest remain in the review hash.
// This validates the user's report, not its authenticity via an agent API call.
export async function verifyUserDeploymentAttestation(proof,raw,{now=new Date(),readSource=readFile,
  gitSource=(commit,path)=>execFileSync('git',['show',`${commit}:${path}`],{maxBuffer:4*1024*1024})}={}){
  assertProofShape(proof);
  const a=JSON.parse(raw),provenance={kind:'user-supplied-local-vercel-attestation',
    agentLiveVerified:false,observedAt:a.observedAt,attestationSha256:hash(raw)};
  assertUserAttestationFresh({provenance},now);
  if(proof.teamId!=='team_6nULXm5hUGvUCNwvc7Axz6GF'||a.teamId!==proof.teamId
    ||proof.projectId!=='prj_iPFlb9rOOVNVtbobMRR1vyV934lf'||a.configurationUnchangedDuringCheck!==true
    ||!isDeepStrictEqual(a.projectBefore,a.projectAfter))
    throw Error('User attestation team/project or stability mismatch');
  const validDeployment=(d,id,commit)=>d?.id===id&&d.projectId===proof.projectId
    &&d.target==='production'&&d.state==='READY'&&isPinnedGitHubSource(d,commit);
  if(!validDeployment(a.baselineDeployment,BASELINE,BASELINE_SHA)
    ||!validDeployment(a.productionDeployment,proof.deploymentId,proof.commit))
    throw Error('User attestation production/baseline source mismatch');
  for(const p of [a.projectBefore,a.projectAfter]){
    if(p?.id!==proof.projectId||p.productionDeploymentId!==proof.deploymentId
      ||p.cronDeploymentId!==proof.deploymentId||p.cronDisabledAtPresent!==true||p.cronDisabledAt!==null
      ||!Array.isArray(p.goCardlessSchedules)||p.goCardlessSchedules.length!==1
      ||p.goCardlessSchedules[0]?.path!=='/api/cron/reconcile-gocardless'
      ||p.goCardlessSchedules[0]?.schedule!=='15 */6 * * *')
      throw Error('User attestation before/after active production cron mismatch');
  }
  await verifyReviewedSources(proof,{readSource,gitSource});
  return {version:1,projectId:proof.projectId,deploymentId:proof.deploymentId,commit:proof.commit,
    teamId:proof.teamId,sourceHashes:proof.sourceHashes,provenance,
    cron:{deploymentId:proof.deploymentId,path:'/api/cron/reconcile-gocardless',
      schedule:'15 */6 * * *',disabledAt:null}};
}
export async function verifyDeploymentProof(proof,{token=process.env.VERCEL_API_TOKEN,vercelRequest,transport=fetch,readSource=readFile,gitSource=(commit,path)=>execFileSync('git',['show',`${commit}:${path}`],{maxBuffer:4*1024*1024})}={}){
  if((!token&&typeof vercelRequest!=='function')||proof?.version!==1||!/^dpl_[A-Za-z0-9]+$/.test(proof.deploymentId||'')
    ||!/^prj_[A-Za-z0-9]+$/.test(proof.projectId||'')||!/^[a-f0-9]{40}$/.test(proof.commit||'')
    ||!proof.sourceHashes||REQUIRED_SOURCES.some(p=>!proof.sourceHashes[p]))throw Error('Complete reviewed deployment/source proof required');
  const get=async path=>{
    const u=new URL(`https://api.vercel.com${path}`);
    if(proof.teamId)u.searchParams.set('teamId',proof.teamId);
    // The connector callback receives only a relative Vercel API path. Replit's
    // proxy injects its credential; neither the callback nor this process sees it.
    const r=vercelRequest
      ?await vercelRequest(`${u.pathname}${u.search}`,{method:'GET',headers:{Accept:'application/json'}})
      :await transport(u,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    if(!r.ok)throw Error(`Production deployment verification unavailable (HTTP ${r.status})`);
    return r.json();
  };
  const baseline=await get(`/v13/deployments/${BASELINE}`);
  if(baseline.id!==BASELINE||!isPinnedGitHubSource(baseline,BASELINE_SHA)
    ||(baseline.projectId||baseline.project?.id)!==proof.projectId)throw Error('Known production project anchor mismatch');
  const project=await get(`/v9/projects/${proof.projectId}`);
  const deployment=await get(`/v13/deployments/${proof.deploymentId}`);
  const cron=project.crons?.definitions?.find(item=>item?.path==='/api/cron/reconcile-gocardless');
  if(project.id!==proof.projectId||project.targets?.production?.id!==proof.deploymentId
    ||project.crons?.deploymentId!==proof.deploymentId||!cron
    ||cron.schedule!=='15 */6 * * *'||project.crons.disabledAt!==null
    ||deployment.id!==proof.deploymentId||(deployment.projectId||deployment.project?.id)!==proof.projectId
    ||deployment.target!=='production'||(deployment.readyState||deployment.state)!=='READY'
    ||!isPinnedGitHubSource(deployment,proof.commit))
    throw Error('Reviewed commit is not the active READY git-backed production deployment');
  await verifyReviewedSources(proof,{readSource,gitSource});
  return {version:1,projectId:proof.projectId,deploymentId:proof.deploymentId,commit:proof.commit,
    cron:{deploymentId:project.crons.deploymentId,path:cron.path,schedule:cron.schedule,disabledAt:project.crons.disabledAt},
    ...(proof.teamId?{teamId:proof.teamId}:{}),sourceHashes:proof.sourceHashes};
}
async function verifyReviewedSources(proof,{readSource,gitSource}){
  const contents={};
  for(const [path,expected]of Object.entries(proof.sourceHashes)){
    if(!/^(api|shared)\/[A-Za-z0-9_./-]+\.(js|mjs)$/.test(path)||path.includes('..')
      ||!/^[a-f0-9]{64}$/.test(expected))throw Error('Invalid reviewed source path/hash');
    const current=await readSource(path);
    if(hash(current)!==expected||hash(await gitSource(proof.commit,path))!==expected)
      throw Error(`Reviewed/deployed source differs: ${path}`);
    contents[path]=current.toString();
  }
  if(!contents['api/_lib/gocardlessDynamicCollections.js'].includes('BNMS pilot processing-not-before')
    ||!contents['api/_lib/gocardlessAccounting.js'].includes('accounting_migration')
    ||!contents['api/_lib/gocardlessDdRenewals.js'].includes('accounting_migration')
    ||!contents['api/_lib/gocardlessDdRenewals.js'].includes('nominated_day'))throw Error('Reviewed source lacks required pilot accounting/renewal/exact-date capabilities');
}