import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startVercelRequestBridge,pollVercelRequestBridge,installVercelBridgeResponse } from './bnms-dd-vercel-connector-bridge.mjs';
import { parseBridgeArgs } from './run-bnms-dd-pilot-release-bridge.mjs';

test('private nonce channel carries only matched fresh allowlisted Vercel GET responses',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'bridge-test-')),directory=join(parent,'channel');
  const bridge=await startVercelRequestBridge(directory,{ttlMs:30000,requestTimeoutMs:5000});
  try{
    assert.equal((await stat(directory)).mode&0o777,0o700);
    const pending=bridge.request('/v13/deployments/dpl_live?teamId=team_test',{method:'GET'});
    let request;
    for(let attempt=0;attempt<20;attempt++){
      request=await pollVercelRequestBridge(directory);
      if(request.state==='request')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.match(request.id,/^[a-f0-9]{48}$/);
    const temp=join(directory,'.incoming-0123456789abcdef.json');
    await writeFile(temp,JSON.stringify({version:1,id:request.id,status:200,body:JSON.stringify({id:'dpl_live'})}));
    await installVercelBridgeResponse(directory,temp);
    const response=await pending;
    assert.equal(response.ok,true);assert.deepEqual(await response.json(),{id:'dpl_live'});
    await assert.rejects(bridge.request('/v2/aliases',{method:'GET'}),/Disallowed/);
    await bridge.close();assert.deepEqual(await pollVercelRequestBridge(directory),{state:'done'});
  }finally{await bridge.close();await rm(parent,{recursive:true,force:true});}
});
test('bridge runner requires exactly one private channel directory',()=>{
  assert.throws(()=>parseBridgeArgs([]),/required/);
  assert.throws(()=>parseBridgeArgs(['--bridge-directory','a','--bridge-directory','b']),/One/);
  assert.deepEqual(parseBridgeArgs(['--bridge-directory','./private','--proof','proof.json']).remaining,
    ['--proof','proof.json']);
});