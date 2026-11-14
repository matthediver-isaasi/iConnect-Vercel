import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectGenericServerOwnedEntity,stripGenericServerOwnedFields} from '../serverOwnedEntityBoundary.js';
test('competition authority and evidence cannot be read through generic entities',()=>{
  for(const entity of ['AwardsCompetition','awards_application_version','AssessmentSession','assessment-moderation-revision','AwardsDelivery']){
    const response={status(code){assert.equal(code,403);return this;},json(){}};
    assert.equal(rejectGenericServerOwnedEntity(entity,response),true);
  }
});
test('generic submission writes cannot assign award context or applicant identity',()=>{
  const payload={rows:[{submission_data:{answer:'retained'},awards_binding_id:'forged',awards_applicant_member_id:'forged-member'}]};
  assert.deepEqual(stripGenericServerOwnedFields('FormSubmission',payload),{rows:[{submission_data:{answer:'retained'}}]});
  assert.equal(payload.rows[0].awards_binding_id,'forged');
});
