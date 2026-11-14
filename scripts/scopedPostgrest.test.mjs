import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopedPostgrest} from './test-support/scoped-postgrest.mjs';
test('native HTTP fixture gateway cannot target remote databases or expose TCP',async t=>{
  const root=await mkdtemp(join(tmpdir(),'postgrest-guard-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'postgrest.conf'),socket=join(root,'postgrest.sock');
  const config={'db-uri':`postgresql:///postgres?host=${encodeURIComponent(root)}&port=5432&user=postgres`,
    'db-anon-role':'anon','db-schemas':'public','jwt-secret':'awards-local-only-not-valid-outside-tests',
    'server-unix-socket':socket,'server-unix-socket-mode':'600','db-pool':1};
  const write=values=>writeFile(path,Object.entries(values).map(([key,value])=>`${key} = ${JSON.stringify(value)}`).join('\n'));
  const check=options=>scopedPostgrest('postgrest',[path],{enabled:true,hasSocket:value=>value===root,...options});
  await write(config);assert.equal(check(),socket);
  assert.equal(check({enabled:false}),null);assert.equal(check({hasSocket:()=>false}),null);
  for(const change of [
    {'db-uri':'postgresql://postgres@example.invalid/postgres'},
    {'db-uri':config['db-uri']+'&host=example.invalid'},
    {'server-host':'0.0.0.0'}, {'server-port':5000},
    {'server-unix-socket':'/tmp/unowned.sock'}, {'server-unix-socket-mode':'777'},
    {'db-pool':20}, {'jwt-secret':'some-other-credential'}, {'db-schemas':'private'},
  ]){await write({...config,...change});assert.equal(check(),null,JSON.stringify(change));}
  await write(config);
  assert.equal(scopedPostgrest('postgrest',[path,'--dump-config'],{enabled:true,hasSocket:()=>true}),null);
});
