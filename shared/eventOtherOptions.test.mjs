import test from 'node:test';
import assert from 'node:assert/strict';
import { optionIsSelected, setOtherDetails, otherDetails, sanitizeStringOptions } from './eventOtherOptions.js';
import { sanitizeOptionSelections } from '../api/_lib/eventOptionSelections.js';
test('Other details retain normal selections and round-trip through booking validation',()=>{
 const answers=setOtherDetails(['Vegan','Other'],'No onions');
 assert.deepEqual(answers,['Vegan','Other: No onions']);
 assert.equal(optionIsSelected(answers,'Other'),true);
 assert.equal(otherDetails(answers),'No onions');
 const saved=sanitizeOptionSelections({dietary_selections:answers,accessibility_selections:['Other: Step-free entrance']},
  {dietary_options:['Vegan','Other'],accessibility_options:['Other']});
 assert.deepEqual(saved.dietary_selections,answers);
 assert.deepEqual(saved.accessibility_selections,['Other: Step-free entrance']);
});
test('free text is accepted only where the event offers Other',()=>{
 assert.deepEqual(sanitizeStringOptions(['Other: A','Forged'],['Vegan']),[]);
 assert.deepEqual(sanitizeStringOptions(['Other: A'],[]),[]);
 assert.deepEqual(sanitizeStringOptions(['Other: A'],[' other ']),['Other: A']);
});
test('details are bounded, clearing retains the choice, historical choices remain valid',()=>{
 assert.equal(otherDetails(setOtherDetails(['Other'],'x'.repeat(600))).length,500);
 assert.equal(otherDetails(sanitizeStringOptions(['Other: '+'x'.repeat(600)],['Other'])).length,500);
 assert.deepEqual(setOtherDetails(['Vegan','Other: old'],''),['Vegan','Other']);
 assert.deepEqual(sanitizeStringOptions(['Vegan','Other'],['Vegan','Other']),['Vegan','Other']);
 assert.equal(optionIsSelected(['Vegan'],'Other'),false);
});
