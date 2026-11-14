import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNotAwardAmendment} from './amendmentBoundary.js';
const db=result=>({from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>result};return q;}});
test('amendment business-action boundary fails closed',async()=>{
  await assert.rejects(assertNotAwardAmendment(db({data:{awards_amendment_application_id:'application'}}),'tenant','submission'),/review evidence only/);
  await assert.rejects(assertNotAwardAmendment(db({error:{code:'503',message:'unavailable'}}),'tenant','submission'),/could not be verified/);
  await assert.rejects(assertNotAwardAmendment(db({data:null}),'tenant','submission'),/unavailable/);
  await assert.rejects(assertNotAwardAmendment(db({error:{code:'42703',message:'other_column missing'}}),'tenant','submission'),/could not be verified/);
});
test('ordinary submissions and the explicitly absent additive column remain compatible',async()=>{
  await assertNotAwardAmendment(db({data:{awards_amendment_application_id:null}}),'tenant','submission');
  await assertNotAwardAmendment(db({error:{code:'42703',message:'awards_amendment_application_id does not exist'}}),'tenant','submission');
});
