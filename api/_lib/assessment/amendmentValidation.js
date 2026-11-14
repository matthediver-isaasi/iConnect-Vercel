import {computeAuthoritativeHiddenFieldIds} from '../formFieldVisibility.js';
import {resolveSubmitControl} from '../formSubmitControl.js';
import {rulesUseLmicOperators} from '../formLmicConditions.js';
import {loadTenantLmicCodes} from '../tenantLmicCodes.js';
import {validateRepeatableRowSubmission} from '../formRepeatableRowValidation.js';
import {createFormRelationshipService} from '../formRelationshipOptions.js';
import {validateFormOrganisationGroupAnswers,validateOrganisationGroupDependentOrganizationAnswers} from '../formOrganisationGroups.js';
import {validateConditionalDisplayNameCopies} from '../formConditionalDisplayNameCopy.js';
import {invalidRequiredAddressLookupFields} from '../idealPostcodes.js';
import {validateFutureDateFields} from '../../../shared/formFutureDates.js';
import {enhancedRequiredAnswerErrors} from '../surveyCompletionBoundary.js';
import {scoreSubmission} from '../surveyScoring.js';

const invalid=(message,details)=>Object.assign(new Error(message),{status:400,details});
// Reuse the canonical form validators, but deliberately import no pipeline,
// payment, mail, member mutation or workflow-execution services.
export async function validateAmendmentEvidence({db,tenantId,form,answers}){
  if(!answers||typeof answers!=='object'||Array.isArray(answers)||JSON.stringify(answers).length>500000)
    throw invalid('Invalid amendment answers');
  const visibilityOptions={};
  if(rulesUseLmicOperators(form.visibility_rules))visibilityOptions.lmicCodes=await loadTenantLmicCodes(db,tenantId);
  const control=resolveSubmitControl(form.visibility_rules,answers,visibilityOptions);
  if(control.disabled)throw invalid(control.message||'These answers cannot be submitted');
  const hidden=await computeAuthoritativeHiddenFieldIds({db,tenantId,form,formValues:answers,visibilityOptions});
  const required=enhancedRequiredAnswerErrors(form.fields,answers,hidden);
  if(required.length)throw invalid('Complete the required questions',required);
  const addresses=invalidRequiredAddressLookupFields(form.fields||[],answers,hidden);
  if(addresses.length)throw invalid('Required address information is missing',addresses);
  const dates=validateFutureDateFields(form.fields||[],answers,{hiddenFieldIds:hidden});
  if(dates.length)throw invalid('Form answers failed validation',dates);
  const relationshipService=createFormRelationshipService({db,tenantId});
  await validateRepeatableRowSubmission({db,tenantId,form,submissionData:answers,visibilityOptions,hiddenFieldIds:hidden});
  await relationshipService.validateSubmission({form,submissionData:answers,hiddenFieldIds:hidden,visibilityOptions});
  const context={db,tenantId,fields:form.fields||[],submissionData:answers,hiddenFieldIds:hidden};
  await validateFormOrganisationGroupAnswers(context);
  await validateOrganisationGroupDependentOrganizationAnswers(context);
  await validateConditionalDisplayNameCopies({db,tenantId,form,submissionData:answers,visibilityOptions,relationshipService});
  if(form.survey_version_id){
    if((form.survey_settings?.response_identity||'identified')!=='identified')
      throw invalid('The published survey no longer permits identified amendments');
    const scoring=scoreSubmission(form,answers);
    if(scoring.errors.length)throw invalid('Survey answers failed validation',scoring.errors);
  }
  return{hiddenFieldIds:hidden};
}
