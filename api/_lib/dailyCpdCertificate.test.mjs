import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyCpdCertificate } from './dailyCpdCertificate.js';
const award = (id,day,points) => ({id,entry_kind:'event_award',points_value:points,rule_snapshot:{itemCpd:{day}}});
test('daily totals combine sessions, sort by date and retain decimals',()=>{
  const result=dailyCpdCertificate([award('b','2026-01-06','1'),award('a','2026-01-05','1.5'),award('c','2026-01-05','.5')]);
  assert.deepEqual(result,{total:3,text:'Monday 5th January 2026 – 2 points\nTuesday 6th January 2026 – 1 point'});
});
test('legacy event awards remain unchanged',()=>assert.equal(dailyCpdCertificate([{id:'a',entry_kind:'event_award',points_value:8}]),null));
test('reversals remove the original day without reawarding',()=>{
  assert.deepEqual(dailyCpdCertificate([award('a','2026-01-05',2),{id:'r',entry_kind:'reversal',reversal_of:'a',points_value:-2}]),{total:0,text:''});
});
test('linked adjustments affect only their original attended day',()=>{
  assert.equal(dailyCpdCertificate([award('a','2026-01-05',2),{id:'r',entry_kind:'adjustment',reversal_of:'a',points_value:-.5}]).total,1.5);
});
test('mixed unallocated historical awards fail closed',()=>{
  assert.throws(()=>dailyCpdCertificate([award('a','2026-01-05',2),{id:'b',entry_kind:'event_award',points_value:8}]),/review/);
});
