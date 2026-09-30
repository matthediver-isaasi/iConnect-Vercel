import { pruneFormNotListedText } from '../../../shared/formNotListedChoice.js';

// Visibility changes are presentation state, not answer invalidation. Keep
// values while fields hide and re-show; option-bearing fields remain
// responsible for clearing answers when a changed parent/options response
// proves that the saved answer is no longer valid.
export const applyFormFieldValueChange = ({
  fields,
  currentValues = {},
  fieldId,
  value,
}) => pruneFormNotListedText(fields, {
  ...currentValues,
  [fieldId]: value,
});