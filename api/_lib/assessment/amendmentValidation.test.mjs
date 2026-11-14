import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAmendmentEvidence} from './amendmentValidation.js';
const db={from(){throw new Error('Unexpected database access for a plain form');}};
test('evidence validation reuses form rules without executing business actions',async()=>{
  const form={fields:[{id:'research',type:'text',required:true}],visibility_rules:[],
    entity_pipelines:{members:[{action:'create'}]},due_diligence_required:true};
  await assert.rejects(validateAmendmentEvidence({db,tenantId:'tenant',form,answers:{}}),/required questions/);
  const validated=await validateAmendmentEvidence({db,tenantId:'tenant',form,answers:{research:'Revised evidence'}});
  assert.ok(validated.hiddenFieldIds instanceof Set);
});
test('invalid answer containers never reach canonical lookup or processing',async()=>{
  for(const answers of [null,[],1,'text']){
    await assert.rejects(validateAmendmentEvidence({db,tenantId:'tenant',form:{fields:[]},answers}),/Invalid amendment/);
  }
});
