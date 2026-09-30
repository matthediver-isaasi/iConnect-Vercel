import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyUserDeploymentAttestation,REQUIRED_SOURCES,assertUserAttestationFresh} from './bnms-dd-pilot-deployment-proof.mjs';
import {parseAlphaReleaseArgs,safeAlphaReadinessError} from './run-bnms-dd-alpha-release.mjs';
const content=Buffer.from('BNMS pilot processing-not-before accounting_migration nominated_day');
const sha=createHash('sha256').update(content).digest('hex');
const proof={version:1,projectId:'prj_iPFlb9rOOVNVtbobMRR1vyV934lf',
  teamId:'team_6nULXm5hUGvUCNwvc7Axz6GF',deploymentId:'dpl_example',commit:'a'.repeat(40),
  sourceHashes:Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,sha]))};
const project={id:proof.projectId,productionDeploymentId:proof.deploymentId,cronDeploymentId:proof.deploymentId,
  cronDisabledAtPresent:true,cronDisabledAt:null,
  goCardlessSchedules:[{path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}]};
const deployment={id:proof.deploymentId,projectId:proof.projectId,target:'production',state:'READY',
  gitSource:{type:'github',repoId:1104295583,sha:proof.commit}};
const original={observedAt:'2026-09-21T09:36:45.532200+00:00',teamId:proof.teamId,
  projectBefore:project,projectAfter:project,productionDeployment:deployment,
  baselineDeployment:{...deployment,id:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',
    gitSource:{...deployment.gitSource,sha:'83ceae1732fb5b63e7312fe5c0baf438831b31f2'}},
  configurationUnchangedDuringCheck:true};
const deps={now:new Date('2026-09-21T09:40:00Z'),readSource:async()=>content,gitSource:()=>content};
test('manual provenance preserves original timestamp and digest, rechecks freshness',async()=>{
  const raw=JSON.stringify(original),v=await verifyUserDeploymentAttestation(proof,raw,deps);
  assert.equal(v.provenance.agentLiveVerified,false);
  assert.equal(v.provenance.observedAt,original.observedAt);
  assert.equal(v.provenance.attestationSha256,createHash('sha256').update(raw).digest('hex'));
  assert.throws(()=>assertUserAttestationFresh(v,new Date('2026-09-21T09:52:00Z')),/15 minutes/);
  assert.throws(()=>assertUserAttestationFresh({...v,provenance:{...v.provenance,agentLiveVerified:true}},deps.now),/provenance/);
});
test('rejects identity, cron, baseline, before/after and time changes',async()=>{
  const changes=[
    a=>a.teamId='wrong',a=>a.projectBefore.id='wrong',a=>a.projectAfter.id='wrong',
    a=>a.projectAfter.productionDeploymentId='wrong',a=>a.projectBefore.cronDeploymentId='wrong',
    a=>a.projectAfter.goCardlessSchedules[0].schedule='* * * * *',
    a=>a.projectBefore.cronDisabledAtPresent=false,a=>a.projectAfter.cronDisabledAt=123,
    a=>a.productionDeployment.gitSource.repoId=1,a=>a.productionDeployment.gitSource.sha='b'.repeat(40),
    a=>a.productionDeployment.state='BUILDING',a=>a.productionDeployment.target='preview',
    a=>a.baselineDeployment.gitSource.sha='b'.repeat(40),a=>a.baselineDeployment.projectId='wrong',
    a=>a.configurationUnchangedDuringCheck=false,a=>delete a.observedAt,
    a=>a.observedAt='2026-09-21T10:00:00.000Z',a=>a.observedAt='2026-09-21T09:00:00.000Z',
    a=>a.observedAt='not-a-date',
  ];
  for(const change of changes){
    const a=structuredClone(original);change(a);
    await assert.rejects(verifyUserDeploymentAttestation(proof,JSON.stringify(a),deps));
  }
});
test('requires seven reviewed sources, deployed git equality and capability markers',async()=>{
  const p=structuredClone(proof);delete p.sourceHashes[REQUIRED_SOURCES[0]];
  await assert.rejects(verifyUserDeploymentAttestation(p,JSON.stringify(original),deps),/proof required/);
  await assert.rejects(verifyUserDeploymentAttestation(proof,JSON.stringify(original),
    {...deps,gitSource:()=>Buffer.from('other')}),/source differs/);
  const noCapabilities=Buffer.from('nothing');
  const hashes=Object.fromEntries(REQUIRED_SOURCES.map(p=>[p,createHash('sha256').update(noCapabilities).digest('hex')]));
  await assert.rejects(verifyUserDeploymentAttestation({...proof,sourceHashes:hashes},JSON.stringify(original),
    {...deps,readSource:async()=>noCapabilities,gitSource:()=>noCapabilities}),/lacks required/);
});
test('attestation is explicit CLI opt-in, forbidden in schema and replay',()=>{
  const args=['--manifest','m','--handover','h','--proof','p','--out','exports/out.json'];
  assert.equal(parseAlphaReleaseArgs(args).attestation,undefined);
  assert.equal(parseAlphaReleaseArgs([...args,'--attestation','a']).attestation,'a');
  assert.throws(()=>parseAlphaReleaseArgs(['--schema','--attestation','a']));
  assert.throws(()=>parseAlphaReleaseArgs([...args,'--attestation']));
  assert.throws(()=>parseAlphaReleaseArgs([...args,'--attestation','a','--apply']),/SHA-256/);
  assert.throws(()=>parseAlphaReleaseArgs([...args,'--attestation','a','--attestation','b']),/duplicate/);
  assert.throws(()=>parseAlphaReleaseArgs(['--replay','r','--out','exports/a','--review-sha256='+'a'.repeat(64),'--attestation','a']));
});
test('readiness error diagnostics allow safe handover cause, never arbitrary token messages',()=>{
  const reason='Fresh exact-alpha legacy collector handover required; beta confirmation is not alpha approval';
  assert.equal(safeAlphaReadinessError(Error(reason)),reason);
  assert.ok(!safeAlphaReadinessError(Error('Bearer secret-token')).includes('secret-token'));
});