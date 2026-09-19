import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyDeploymentProof,REQUIRED_SOURCES} from './bnms-dd-pilot-deployment-proof.mjs';
import {parseReleaseArgs} from './run-bnms-dd-pilot-release.mjs';
test('release CLI never accepts an unchecked deployed flag or identity override',()=>{
  for(const args of [['--deployed'],['--member','other'],['--out','/tmp/a'],['--proof','/tmp/p','--out','/tmp/a','--apply']])
    assert.throws(()=>parseReleaseArgs(args));
  assert.equal(parseReleaseArgs(['--proof','/tmp/p','--out','/tmp/a']).apply,false);
});
test('deployment proof requires active production commit, project anchor, local and git source bytes',async()=>{
  const content=Buffer.from('accounting_migration nominated_day BNMS pilot exact October 1 cutover missed');
  const sum=createHash('sha256').update(content).digest('hex'),commit='a'.repeat(40);
  const proof={version:1,projectId:'prj_test',deploymentId:'dpl_new',commit,
    sourceHashes:Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,sum]))};
  let responses={
    '/v13/deployments/dpl_6hEq9mdejDLdB9eUukppK419dPWt':{id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',projectId:'prj_test',
      source:'redeploy',gitSource:{type:'github',repoId:1104295583,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}},
    '/v9/projects/prj_test':{id:'prj_test',targets:{production:{id:'dpl_new'}},
      crons:{deploymentId:'dpl_new',disabledAt:null,
        definitions:[{host:'example.test',path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}]}},
    '/v13/deployments/dpl_new':{id:'dpl_new',projectId:'prj_test',target:'production',readyState:'READY',
      gitSource:{type:'github',repoId:1104295583,sha:commit}},
  };
  const deps={token:'test-only',readSource:async()=>content,gitSource:()=>content,
    transport:async(url,opts)=>{assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return {ok:true,json:async()=>responses[url.pathname]};}};
  const verified=await verifyDeploymentProof(proof,deps);
  assert.equal(verified.commit,commit);
  assert.deepEqual(verified.cron,{deploymentId:'dpl_new',path:'/api/cron/reconcile-gocardless',
    schedule:'15 */6 * * *',disabledAt:null});
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
  responses['/v9/projects/prj_test'].crons.definitions[0].schedule='15 */6 * * *';
  responses['/v9/projects/prj_test'].crons.disabledAt=1;
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
  responses['/v9/projects/prj_test'].crons.definitions=[];
  await assert.rejects(verifyDeploymentProof(proof,deps),/not the active/);
});
test('deployment proof can use credentialless live Vercel connector requests only',async()=>{
  const content=Buffer.from('accounting_migration nominated_day BNMS pilot exact October 1 cutover missed');
  const sum=createHash('sha256').update(content).digest('hex'),commit='b'.repeat(40);
  const proof={version:1,projectId:'prj_test',deploymentId:'dpl_new',commit,teamId:'team_test',
    sourceHashes:Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,sum])),
    project:{id:'prj_test',targets:{production:{id:'dpl_new'}}}};
  const responses={
    '/v13/deployments/dpl_6hEq9mdejDLdB9eUukppK419dPWt?teamId=team_test':{id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',projectId:'prj_test',
      source:'redeploy',gitSource:{type:'github',repoId:1104295583,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}},
    '/v9/projects/prj_test?teamId=team_test':{id:'prj_test',targets:{production:{id:'dpl_new'}},
      crons:{deploymentId:'dpl_new',disabledAt:null,
        definitions:[{host:'example.test',path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}]}},
    '/v13/deployments/dpl_new?teamId=team_test':{id:'dpl_new',projectId:'prj_test',target:'production',readyState:'READY',
      gitSource:{type:'github',repoId:1104295583,sha:commit}},
  };
  const requested=[];
  const verified=await verifyDeploymentProof(proof,{token:null,readSource:async()=>content,gitSource:()=>content,
    vercelRequest:async(path,init)=>{
      requested.push(path);
      assert.deepEqual(init,{method:'GET',headers:{Accept:'application/json'}});
      return {ok:true,json:async()=>responses[path]};
    }});
  assert.equal(verified.commit,commit);
  assert.deepEqual(requested,Object.keys(responses));
  assert.equal('project' in verified,false,'downloaded API JSON in proof must not become evidence');
});