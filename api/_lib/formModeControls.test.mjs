import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {usesStandardEmailLimit, submissionEventContext} from './formModeControls.js';

const legacy = {prevent_duplicate_email_submission:true,is_event_related:true,related_event_id:'old'};
test('surveys ignore a legacy global email limit without mutating saved configuration',()=>{
  const survey={...legacy,form_type:'survey'};
  assert.equal(usesStandardEmailLimit(survey),false);
  assert.deepEqual(survey,{...legacy,form_type:'survey'});
  for(const form_type of ['standard',undefined,null])assert.equal(usesStandardEmailLimit({...legacy,form_type}),true);
  assert.equal(usesStandardEmailLimit({}),false);
});
test('unassigned survey never inherits a legacy single-event link',()=>{
  assert.deepEqual(submissionEventContext({...legacy,form_type:'survey'}),{});
  assert.deepEqual(submissionEventContext(legacy),{event_id:'old'});
});
test('survey simple and training event contexts come only from resolved assignments',()=>{
  const survey={...legacy,form_type:'survey'};
  assert.deepEqual(submissionEventContext(survey,{id:'a',event_type:'event',event_id:'new'}),
    {survey_assignment_id:'a',event_id:'new'});
  assert.deepEqual(submissionEventContext(survey,{id:'b',event_type:'complex_event',complex_event_id:'training',event_id:'stale'}),
    {survey_assignment_id:'b',complex_event_id:'training'});
});
test('real submission handler uses mode guards while retaining published survey dedupe',()=>{
  const source=readFileSync(new URL('../public/form-submission.js',import.meta.url),'utf8');
  assert.match(source,/usesStandardEmailLimit\(form\) && canonicalSubmitterEmail/);
  assert.match(source,/\.\.\.submissionEventContext\(form, surveyAssignment\)/);
  assert.match(source,/snapshotSettings\.one_submission_per_respondent === true/);
  assert.match(source,/respondentKeyInput\(tenantData\.id, form\.id, surveyAssignment\?\.id/);
});
