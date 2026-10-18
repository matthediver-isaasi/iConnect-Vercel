import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planRows} from './import-bnms-historical-memberships.mjs';
const row = [123,'Full Membership ',new Date('2028-07-31'),null,'11111111-1111-4111-a111-111111111111'];
test('deduplicates only exact complete rows and preserves source values',()=>{
  const rows=planRows([row,[...row],[123,'Full Membership',row[2],null,row[4]],[123,row[1],new Date('2020-01-01'),null,row[4]]]);
  assert.equal(rows.length,3);
  assert.equal(rows[0].data.membership,'Full Membership ');
  assert.equal(rows[0].data.start_date,'2028-07-31');
  assert.equal(rows[0].data.end_date,null);
  assert.deepEqual(Object.keys(rows[0].data),['website_id','membership','start_date','end_date']);
});
test('same history for different members is retained',()=>{
  assert.equal(planRows([row,[...row.slice(0,4),'22222222-2222-4222-a222-222222222222']]).length,2);
});
test('identities stable across input order',()=>{
  const other=[123,'Guest',row[2],null,row[4]];
  assert.equal(planRows([row,other])[0].id,planRows([other,row])[1].id);
});
test('invalid dates or missing required start fail closed',()=>{
  assert.throws(()=>planRows([[123,'Guest','invalid',null,row[4]]]));
  assert.throws(()=>planRows([[123,'Guest',null,null,row[4]]]));
});
