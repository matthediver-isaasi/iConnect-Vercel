import test from 'node:test';
import assert from 'node:assert/strict';
import {computeEvidence,computeModerationScore} from './evidence.js';
const score=n=>({numerator:String(n),denominator:'1'});
test('only moderation tied to the current submitted evidence changes rankings',()=>{
  const evidence={round:{required_judges:1,require_all:true},
    assessments:[{assignmentId:'a',revisionId:'r1',state:'submitted',included:true,recused:false,score:score(60)}],
    moderation:{state:'approved',revision:{action:'approved',assessment_revision_ids:['r1'],exact_score:score(90)}}};
  assert.deepEqual(computeEvidence(evidence).official.officialScore,score(90));
  evidence.moderation.authorityValid=false;
  assert.deepEqual(computeEvidence(evidence).official.officialScore,score(60));
  evidence.moderation.authorityValid=true;
  evidence.assessments[0].revisionId='r2';
  assert.deepEqual(computeEvidence(evidence).official.officialScore,score(60));
  evidence.assessments[0].state='draft';
  assert.equal(computeEvidence(evidence).official.complete,false);
});
test('overall moderation enforces the 0–100 scale without floating rounding',()=>{
  assert.deepEqual(computeModerationScore({method:'overall',overall:'90.125'}),{numerator:'721',denominator:'8'});
  assert.throws(()=>computeModerationScore({method:'overall',overall:101}),/range/);
});
