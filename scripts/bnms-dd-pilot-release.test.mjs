import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {verifyDeploymentProof,REQUIRED_SOURCES} from './bnms-dd-pilot-deployment-proof.mjs';
import {parseReleaseArgs} from './run-bnms-dd-pilot-release.mjs';
const content=Buffer.from('accounting_migration nominated_day BNMS_AUTOMATIC_PROCESSING_NOT_BEFORE BNMS beta reviewed release and processing gate are required');
const config=Buffer.from(JSON.stringify({crons:[{path:'/api/cron/reconcile-gocardless',schedule:'*/5 * * * *'}]}));
const source=path=>path==='vercel.json'?config:content;
const sourceHashes=()=>Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,createHash('sha256').update(source(p)).digest('hex')]));
test('release CLI never accepts an unchecked deployed flag or identity override',()=>{
  for(const args of [['--deployed'],['--member','other'],['--out','/tmp/a'],['--proof','/tmp/p','--out','/tmp/a','--apply']])
    assert.throws(()=>parseReleaseArgs(args));
  assert.equal(parseReleaseArgs(['--proof','/tmp/p','--out','/tmp/a']).apply,false);
});
test('deployment proof requires active production commit, project anchor, local and git source bytes',async()=>{
  const commit='a'.repeat(40);
  const proof={version:1,projectId:'prj_test',deploymentId:'dpl_new',commit,
    sourceHashes:sourceHashes()};
  let responses={
    '/v13/deployments/dpl_6hEq9mdejDLdB9eUukppK419dPWt':{id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',projectId:'prj_test',
      source:'redeploy',gitSource:{type:'github',repoId:1104295583,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}},
    '/v9/projects/prj_test':{id:'prj_test',targets:{production:{id:'dpl_new'}},
      crons:{deploymentId:'dpl_new',disabledAt:null,
        definitions:[{host:'example.test',path:'/api/cron/reconcile-gocardless',schedule:'*/5 * * * *'}]}},
    '/v13/deployments/dpl_new':{id:'dpl_new',projectId:'prj_test',target:'production',readyState:'READY',
      gitSource:{type:'github',repoId:1104295583,sha:commit}},
  };
  const deps={token:'test-only',readSource:async path=>source(path),gitSource:(_commit,path)=>source(path),
    transport:async(url,opts)=>{assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return {ok:true,json:async()=>responses[url.pathname]};}};
  const verified=await verifyDeploymentProof(proof,deps);
  assert.equal(verified.commit,commit);
  assert.deepEqual(verified.cron,{deploymentId:'dpl_new',path:'/api/cron/reconcile-gocardless',
    schedule:'*/5 * * * *',disabledAt:null});
  await assert.rejects(verifyDeploymentProof(proof,{...deps,token:null,vercelRequest:null}),/proof required/);
  await assert.rejects(verifyDeploymentProof(proof,{...deps,gitSource:()=>Buffer.from('old code')}),/source differs/);
  await assert.rejects(verifyDeploymentProof(proof,{...deps,transport:async()=>({ok:false,status:403})}),/HTTP 403/);
  responses['/v9/projects/prj_test'].targets.production.id='dpl_old';
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].targets.production.id='dpl_new';
  responses['/v13/deployments/dpl_new'].gitSource.repoId=99;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  delete responses['/v13/deployments/dpl_new'].gitSource.repoId;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v13/deployments/dpl_new'].gitSource={type:'gitlab',repoId:1104295583,sha:commit};
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  delete responses['/v13/deployments/dpl_new'].gitSource.type;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  delete responses['/v13/deployments/dpl_new'].gitSource;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v13/deployments/dpl_new'].gitSource={type:'github',repoId:1104295583,sha:commit};
  responses['/v9/projects/prj_test'].crons.deploymentId='dpl_old';
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].crons.deploymentId='dpl_new';
  responses['/v9/projects/prj_test'].crons.definitions[0].schedule='0 * * * *';
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].crons.definitions[0].schedule='*/5 * * * *';
  responses['/v9/projects/prj_test'].crons.definitions.push({...responses['/v9/projects/prj_test'].crons.definitions[0]});
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].crons.definitions.pop();
  responses['/v9/projects/prj_test'].crons.disabledAt=1;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].crons.definitions=[];
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
});
test('deployment proof can use credentialless live Vercel connector requests only',async()=>{
  const commit='b'.repeat(40);
  const proof={version:1,projectId:'prj_test',deploymentId:'dpl_new',commit,teamId:'team_test',
    sourceHashes:sourceHashes(),
    project:{id:'prj_test',targets:{production:{id:'dpl_new'}}}};
  const responses={
    '/v13/deployments/dpl_6hEq9mdejDLdB9eUukppK419dPWt?teamId=team_test':{id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',projectId:'prj_test',
      source:'redeploy',gitSource:{type:'github',repoId:1104295583,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}},
    '/v9/projects/prj_test?teamId=team_test':{id:'prj_test',targets:{production:{id:'dpl_new'}},
      crons:{deploymentId:'dpl_new',disabledAt:null,
        definitions:[{host:'example.test',path:'/api/cron/reconcile-gocardless',schedule:'*/5 * * * *'}]}},
    '/v13/deployments/dpl_new?teamId=team_test':{id:'dpl_new',projectId:'prj_test',target:'production',readyState:'READY',
      gitSource:{type:'github',repoId:1104295583,sha:commit}},
  };
  const requested=[];
  const verified=await verifyDeploymentProof(proof,{token:null,readSource:async path=>source(path),gitSource:(_commit,path)=>source(path),
    vercelRequest:async(path,init)=>{
      requested.push(path);
      assert.deepEqual(init,{method:'GET',headers:{Accept:'application/json'}});
      return {ok:true,json:async()=>responses[path]};
    }});
  assert.equal(verified.commit,commit);
  assert.deepEqual(requested,Object.keys(responses));
  assert.equal('project' in verified,false,'downloaded API JSON in proof must not become evidence');
});
function fixture(sources=Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,source(p)]))){
  const commit='c'.repeat(40),proof={version:1,projectId:'prj_fixture',deploymentId:'dpl_fixture',commit,
    sourceHashes:Object.fromEntries(Object.entries(sources).map(([p,bytes])=>[p,createHash('sha256').update(bytes).digest('hex')]))};
  const project={id:proof.projectId,targets:{production:{id:proof.deploymentId}},
    crons:{deploymentId:proof.deploymentId,disabledAt:null,
      definitions:[{path:'/api/cron/reconcile-gocardless',schedule:'*/5 * * * *'}]}};
  const deployment={id:proof.deploymentId,projectId:proof.projectId,target:'production',readyState:'READY',
    gitSource:{type:'github',repoId:1104295583,sha:commit}};
  const baseline={...deployment,id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',
    gitSource:{...deployment.gitSource,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}};
  const requested=[];
  const deps={token:null,readSource:async p=>sources[p],gitSource:(_commit,p)=>sources[p],
    vercelRequest:async(p,init)=>{
      requested.push(p);assert.equal(init.method,'GET');
      const body=p===`/v9/projects/${proof.projectId}`?project
        :p===`/v13/deployments/${baseline.id}`?baseline
        :p===`/v13/deployments/${proof.deploymentId}`?deployment:null;
      assert.ok(body,'Only pinned fixture routes allowed');
      return {ok:true,json:async()=>body};
    }};
  return {proof,project,deployment,baseline,deps,requested};
}
test('active cron rejects old/wrong/duplicate/missing/disabled and deployment identity drift',async()=>{
  for(const change of [
    f=>f.project.crons.definitions[0].schedule='15 */6 * * *',
    f=>f.project.crons.definitions[0].path='/api/cron/other',
    f=>f.project.crons.definitions.push({...f.project.crons.definitions[0]}),
    f=>f.project.crons.definitions=[],
    f=>delete f.project.crons.definitions,
    f=>f.project.crons.disabledAt=123,
    f=>delete f.project.crons.disabledAt,
    f=>f.project.crons.deploymentId='dpl_old',
    f=>f.project.targets.production.id='dpl_old',
    f=>f.project.id='prj_other',
    f=>f.deployment.projectId='prj_other',
    f=>f.deployment.id='dpl_other',
    f=>f.deployment.readyState='BUILDING',
    f=>f.deployment.target='preview',
    f=>f.deployment.gitSource.sha='d'.repeat(40),
    f=>f.deployment.gitSource.repoId=123,
    f=>f.baseline.gitSource.sha='d'.repeat(40),
  ]){
    const f=fixture();change(f);
    await assert.rejects(verifyDeploymentProof(f.proof,f.deps),/active|anchor/);
  }
});
test('every required source/config hash binds both local bytes and reviewed commit; no requests on stale sources',async()=>{
  const bare=fixture();
  await assert.rejects(verifyDeploymentProof({commit:bare.proof.commit},bare.deps),/proof required/);
  assert.equal(bare.requested.length,0,'A user-confirmed commit alone is not deployment evidence');
  for(const path of REQUIRED_SOURCES){
    let f=fixture();delete f.proof.sourceHashes[path];
    await assert.rejects(verifyDeploymentProof(f.proof,f.deps),/proof required/);
    assert.equal(f.requested.length,0);
    for(const mode of ['local','git']){
      f=fixture();
      const deps={...f.deps,...(mode==='local'
        ?{readSource:async p=>p===path?Buffer.from('stale source'):source(p)}
        :{gitSource:(commit,p)=>{assert.equal(commit,f.proof.commit);return p===path?Buffer.from('stale source'):source(p);}})};
      await assert.rejects(verifyDeploymentProof(f.proof,deps),/source differs/);
      assert.equal(f.requested.length,0);
    }
  }
  for(const [path,value]of [['api/../secrets.js','a'.repeat(64)],['other.json','a'.repeat(64)],['api/_lib/xero.js','invalid']]){
    const f=fixture();f.proof.sourceHashes[path]=value;
    await assert.rejects(verifyDeploymentProof(f.proof,f.deps),/Invalid reviewed source path\/hash/);
    assert.equal(f.requested.length,0);
  }
});
test('even matching git hashes cannot approve old, duplicate or absent commit-config cron',async()=>{
  for(const crons of [
    [{path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}],
    Array(2).fill({path:'/api/cron/reconcile-gocardless',schedule:'*/5 * * * *'}),
    [],null,
  ]){
    const sources=Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,source(p)]));
    sources['vercel.json']=Buffer.from(JSON.stringify({crons}));
    const f=fixture(sources);
    await assert.rejects(verifyDeploymentProof(f.proof,f.deps),/exactly one five-minute/);
    assert.equal(f.requested.length,0);
  }
  const sources=Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,source(p)]));
  sources['vercel.json']=Buffer.from('not JSON');
  const f=fixture(sources);
  await assert.rejects(verifyDeploymentProof(f.proof,f.deps),/valid JSON/);
});
test('current real reviewed git sources support five-minute cron and relocated pipeline gate (Vercel mocked)',async()=>{
  const sources=Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,readFileSync(p)]));
  const f=fixture(sources),commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  f.proof.commit=commit;f.deployment.gitSource.sha=commit;
  const verified=await verifyDeploymentProof(f.proof,{...f.deps,
    gitSource:(sha,p)=>execFileSync('git',['show',`${sha}:${p}`],{maxBuffer:4*1024*1024})});
  assert.equal(verified.cron.schedule,'*/5 * * * *');
  assert.equal(sources['api/_lib/gocardlessDynamicCollections.js'].includes('BNMS pilot processing-not-before'),false);
  for(const path of ['vercel.json','api/cron/reconcile-gocardless.js',
    'api/_lib/directDebitDynamicPipeline.js','api/_lib/directDebitReconciliationPipeline.js']){
    assert.equal(verified.sourceHashes[path],createHash('sha256').update(sources[path]).digest('hex'));
  }
});