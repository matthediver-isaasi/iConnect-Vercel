// Grouped questions store text answers by saved sub-question ID.
// Unknown IDs are retained without presenting those IDs as question text.
export function groupedQuestionPdfAnswers(field, value) {
  const answerText = (answer) => {
    if (answer == null) return '';
    if (Array.isArray(answer)) return answer.map(answerText).filter(text => text.trim()).join(', ');
    if (typeof answer === 'object') {
      return Object.values(answer).map(answerText).filter(text => text.trim()).join('\n');
    }
    return String(answer);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const answer = answerText(value);
    return answer.trim() ? [{ label: 'Unavailable question', answer }] : [];
  }
  const definitions = new Map();
  for (const question of Array.isArray(field?.sub_questions) ? field.sub_questions : []) {
    if (question?.id && !definitions.has(String(question.id))) {
      definitions.set(String(question.id), question.label?.trim() || 'Unavailable question');
    }
  }
  const ids = new Set([...definitions.keys(), ...Object.keys(value)]);
  return [...ids].flatMap(id => {
    if (!Object.hasOwn(value, id)) return [];
    const answer = answerText(value[id]);
    return answer.trim() ? [{ label: definitions.get(id) || 'Unavailable question', answer }] : [];
  });
}