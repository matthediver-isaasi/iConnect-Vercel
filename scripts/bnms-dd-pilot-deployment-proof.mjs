import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const BASELINE='dpl_6hEq9mdejDLdB9eUukppK419dPWt';
const BASELINE_SHA='83ceae1732fb5b63e7312fe5c0baf438831b31f2';
const GITHUB_REPOSITORY_ID=1104295583;
export const REQUIRED_SOURCES=[
  'api/_lib/gocardlessAccounting.js','api/_lib/membershipInstalmentInvoicing.js',
  'api/_lib/xero.js','api/_lib/gocardlessDdRenewals.js','api/_lib/gocardlessDynamicCollections.js',
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const isPinnedGitHubSource=(deployment,commit)=>deployment.gitSource?.type==='github'
  &&deployment.gitSource.repoId===GITHUB_REPOSITORY_ID&&deployment.gitSource.sha===commit;
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
  return {version:1,projectId:proof.projectId,deploymentId:proof.deploymentId,commit:proof.commit,
    cron:{deploymentId:project.crons.deploymentId,path:cron.path,schedule:cron.schedule,disabledAt:project.crons.disabledAt},
    ...(proof.teamId?{teamId:proof.teamId}:{}),sourceHashes:proof.sourceHashes};
}