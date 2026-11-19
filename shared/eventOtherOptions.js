// Keep answers in the existing string arrays so bookings, reports and exports
// retain readable details without adding columns or changing historical values.
export const OTHER_DETAILS_MAX_LENGTH = 500;
export const isOtherOption = value => typeof value === 'string' && value.trim().toLowerCase() === 'other';
export const isOtherAnswer = value => isOtherOption(value)
  || (typeof value === 'string' && /^other:/i.test(value));
export function optionIsSelected(selections, option) {
  return isOtherOption(option) ? selections.some(isOtherAnswer) : selections.includes(option);
}
export function otherDetails(selections) {
  const answer = selections.find(v => typeof v === 'string' && /^other:/i.test(v));
  return answer ? answer.slice(6).replace(/^ /, '') : '';
}
export function setOtherDetails(selections, text) {
  return [...selections.filter(v => !isOtherAnswer(v)), text ? `Other: ${text.slice(0, OTHER_DETAILS_MAX_LENGTH)}` : 'Other'];
}
export function sanitizeStringOptions(selections, allowed) {
  const output = [];
  for (const value of Array.isArray(selections) ? selections : []) {
    if (typeof value !== 'string') continue;
    if (allowed.includes(value)) output.push(value);
    else if (allowed.some(isOtherOption) && isOtherAnswer(value)) {
      const detail = otherDetails([value]).trim().slice(0, OTHER_DETAILS_MAX_LENGTH);
      output.push(detail ? `Other: ${detail}` : 'Other');
    }
  }
  return [...new Set(output)];
}
