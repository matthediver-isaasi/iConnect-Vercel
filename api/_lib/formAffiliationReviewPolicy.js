import {
  containsFormNotListedValue,
  FORM_NOT_LISTED_TEXT_MAX_LENGTH,
} from '../../shared/formNotListedChoice.js';

/**
 * Input is produced by the server's configured-field/visibility resolver, not
 * a browser-authored list. Text is evidence, never an entity-creation request.
 */
export function collectAffiliationReviewRequests(choices = []) {
  if (!Array.isArray(choices) || choices.length > 500) throw new Error('Invalid affiliation choices');
  const requests = [];
  const seen = new Set();
  for (const choice of choices) {
    if (typeof choice?.visible !== 'boolean') throw new Error('Authoritative field visibility is required');
    if (!choice.visible || !containsFormNotListedValue(choice.value)) continue;
    if (!['organization', 'department'].includes(choice.kind)
      || typeof choice.fieldId !== 'string' || !choice.fieldId.trim()
      || (choice.rowKey != null && (typeof choice.rowKey !== 'string' || !choice.rowKey.trim()))) {
      throw new Error('Invalid affiliation review source');
    }
    const text = typeof choice.notListedText === 'string' ? choice.notListedText.trim() : '';
    if (!text || text.length > FORM_NOT_LISTED_TEXT_MAX_LENGTH) {
      throw new Error(`Enter the missing ${choice.kind} name (up to ${FORM_NOT_LISTED_TEXT_MAX_LENGTH} characters)`);
    }
    const identity = JSON.stringify([choice.fieldId, choice.rowKey ?? null]);
    if (seen.has(identity)) throw new Error('Duplicate affiliation review source');
    seen.add(identity);
    requests.push({
      kind: choice.kind,
      fieldId: choice.fieldId,
      rowKey: choice.rowKey ?? null,
      requestedName: text,
    });
  }
  return requests;
}
