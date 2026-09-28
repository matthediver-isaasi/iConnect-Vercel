// This mode is intentionally limited to public forms whose only existing-record
// mutation target is a member. A reference to an organisation is not authority
// to update that organisation.
import { assessFormMutationAccess, FORM_MUTATION_ACCESS_MODES } from '../../../shared/formMutationContract.js';
import { getValidatedReturnTo } from './memberOnlyHtml.js';

export const PUBLIC_MEMBER_SIGNUP_MODE = FORM_MUTATION_ACCESS_MODES.PUBLIC_MEMBER_SIGNUP;
export const FORM_MEMBER_OWNER_REQUIRED = 'FORM_MEMBER_OWNER_REQUIRED';

export function canUsePublicMemberSignup(form) {
  const assessment = assessFormMutationAccess({
    ...form,
    mutation_access_policy: { version: 1, mode: PUBLIC_MEMBER_SIGNUP_MODE },
  });
  return assessment.ok && assessment.hasExistingRecordMutation;
}

export function memberOwnerRequired(error) {
  const data = error?.errorData;
  return data?.code === FORM_MEMBER_OWNER_REQUIRED
    || data?.error?.code === FORM_MEMBER_OWNER_REQUIRED;
}

// Only use the current browser path, never a respondent-supplied return URL.
// Keeping its query intact allows an existing draft link to survive login;
// draft answers themselves do not confer ownership.
export function memberSignupLoginUrl(location) {
  const returnTo = getValidatedReturnTo({
    pathname: location?.pathname || '/',
    search: location?.search || '',
    hash: location?.hash || '',
  });
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}