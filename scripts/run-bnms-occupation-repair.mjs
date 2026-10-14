import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
import { executeRepair } from './bnms-job-title-repair-db.mjs';
import { TENANT, hash } from './bnms-job-title-repair-core.mjs';
const dir='generated-artifacts/bnms-occupation-repair';
const mode=process.argv[2];
assert.ok(['dry-run','apply'].includes(mode));
const manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8'));
assert.equal(hash(manifest),'495eebccd516b95bdc5c3fa2037a2c16369cb6b3286eb6fff1fc0ea39996e64b');
assert.equal(manifest.tenant,TENANT);
assert.equal(manifest.items.length,105);
for(const source of manifest.sourceFiles) {
  assert.equal(createHash('sha256').update(fs.readFileSync(source.file)).digest('hex'),source.fingerprint);
}
const db=await connectDestination();
try {
  const result=await executeRepair(db,manifest.items,manifest.schemaHash,{
    apply:mode==='apply',
    journal:(stage,data)=>fs.writeFileSync(`${dir}/${stage}-${Date.now()}.json`,JSON.stringify(data,null,2),
      {flag:'wx',mode:0o600}),
  });
  if(mode==='apply')fs.writeFileSync(`${dir}/receipt-${Date.now()}.json`,
    JSON.stringify({...result,manifestHash:hash(manifest),committedAt:new Date().toISOString()},null,2),
    {flag:'wx',mode:0o600});
  console.log(JSON.stringify({mode,...Object.fromEntries(Object.entries(result).filter(([key])=>key!=='after'))}));
} finally {await db.end();}
