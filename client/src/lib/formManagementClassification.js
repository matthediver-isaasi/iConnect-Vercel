export const FORM_CLASSIFICATION_ALL = 'all';

export function getFormLayoutClassification(form) {
  return form?.layout_type === 'card_swipe' ? 'card_swipe' : 'standard';
}

export function isSurveyForm(form) {
  return form?.form_type === 'survey';
}

export function isEventLinkedForm(form) {
  return form?.is_event_related === true;
}

export function matchesFormClassification(form, classification) {
  switch (classification) {
    case 'standard':
    case 'card_swipe':
      return getFormLayoutClassification(form) === classification;
    case 'survey':
      return isSurveyForm(form);
    case 'event_linked':
      return isEventLinkedForm(form);
    case FORM_CLASSIFICATION_ALL:
    default:
      return true;
  }
}