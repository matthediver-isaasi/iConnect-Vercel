import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareShortlist} from './rankings.js';
const entry=(id,n)=>({id,eligibility:'eligible',complete:true,officialScore:{numerator:String(n),denominator:'1'},moderationRequired:false});
test('top-ranked cutoff ties require explicit decisions rather than rounded ordering',()=>{
  const rankings={entries:[entry('a',90),entry('b',80),entry('c',80)]};
  const input={mode:'top_ranked',limit:2,state:'recommended',applicationIds:['b'],reason:'Panel tie decision'};
  assert.throws(()=>prepareShortlist(rankings,input),/override/);
  const result=prepareShortlist(rankings,{...input,override:true});
  assert.deepEqual(result.recommendation.tied,['b','c']);
  assert.equal(result.decisions[0].override,true);
});
test('mandatory moderation and incompleteness cannot silently produce recommendations',()=>{
  const incomplete={...entry('a',null),complete:false,officialScore:null};
  assert.throws(()=>prepareShortlist({entries:[incomplete]},{mode:'manual',state:'recommended',applicationIds:['a'],reason:'Manual choice'}),/override/);
  assert.throws(()=>prepareShortlist({entries:[{...entry('b',95),moderationRequired:true,moderationState:'proposed'}]},
    {mode:'manual',state:'recommended',applicationIds:['b'],override:true,reason:'Manual choice'}),/moderation/);
});
