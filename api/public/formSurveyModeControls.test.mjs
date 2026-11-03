import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibilityForm,submitThroughRealProcessor} from './formSubmissionCompatibility.helpers.mjs';

test('legacy survey switches cannot trigger standard global dedupe or event attribution in real submission',async()=>{
  const form={...compatibilityForm(),form_type:'survey',fields:[{id:'email',type:'email'}],
    entity_action:'none',organization_entity_action:'none',entity_pipelines:{members:[],organisations:[]},
    prevent_duplicate_email_submission:true,is_event_related:true,related_event_id:'legacy-event',
    survey_settings:{status:'published',current_version:1,response_identity:'identified',one_submission_per_respondent:false}};
  const result=await submitThroughRealProcessor({form,submissionData:{email:'fixture@example.test'},
    receiptRows:{survey_version:{id:'version',form_id:form.id,tenant_id:form.tenant_id,version_number:1,
      fields:form.fields,pages:[],visibility_rules:[],survey_settings:form.survey_settings}}});
  assert.equal(result.response.statusCode,201,JSON.stringify(result.response.body));
  assert.ok(result.insertedSubmissions.length);
  assert.equal(result.insertedSubmissions[0].event_id,undefined);
  assert.equal(result.insertedSubmissions[0].survey_assignment_id,undefined);
});
