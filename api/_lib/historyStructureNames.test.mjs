import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLinkedHistoryStructureNames } from './historyStructureNames.js';

test('exact tenant-scoped IDs only; historical/retired structures allowed; no financial changes', async () => {
  const rows = [
    { tenant_id:'tenant', config_id:'old', tier_label:'Tier 9', final_cost:100 },
    { tenant_id:'tenant', config_id:'missing' },
    { tenant_id:'other', config_id:'old', linked_structure_name:'unsafe' },
  ];
  const db={from(table) {
    assert.equal(table,'membership_tier_config');
    return {select(columns) {assert.equal(columns,'id,tenant_id,name'); return this;},
      eq(key,value) {assert.equal(key,'tenant_id');assert.equal(value,'tenant');return this;},
      async in(key,ids) {assert.equal(key,'id');assert.deepEqual(ids,['old','missing']);
        return {data:[{id:'old',tenant_id:'tenant',name:'Historical structure'},{id:'missing',tenant_id:'other',name:'Wrong tenant'}]};}};
  }};
  await attachLinkedHistoryStructureNames(db,'tenant',rows);
  assert.deepEqual(rows[0],{tenant_id:'tenant',config_id:'old',tier_label:'Tier 9',final_cost:100,linked_structure_name:'Historical structure'});
  assert.equal(rows[1].linked_structure_name,undefined);
  assert.equal(rows[2].linked_structure_name,undefined);
});
test('empty history makes no requests; lookup failure is explicit',async()=>{
  await attachLinkedHistoryStructureNames({},'tenant',[]);
  const db={from:()=>({select(){return this;},eq(){return this;},in:async()=>({error:{message:'offline'}})})};
  await assert.rejects(attachLinkedHistoryStructureNames(db,'tenant',[{tenant_id:'tenant',config_id:'old'}]),/Could not load/);
});
