export const MAX_SET_VALUE_CONVERGENCE_STEPS = 32;

const isPlainRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function formValuesSemanticallyEqual(left, right) {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => formValuesSemanticallyEqual(value, right[index]));
  }

  if (isPlainRecord(left) || isPlainRecord(right)) {
    if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => (
      key === rightKeys[index]
      && formValuesSemanticallyEqual(left[key], right[key])
    ));
  }

  return false;
}

export function mergeSemanticFormValueUpdates(currentValues, updates) {
  let nextValues = currentValues;
  for (const [fieldId, value] of Object.entries(updates || {})) {
    if (formValuesSemanticallyEqual(currentValues?.[fieldId], value)) continue;
    if (nextValues === currentValues) nextValues = { ...(currentValues || {}) };
    nextValues[fieldId] = value;
  }
  return nextValues;
}

const canonicalValue = (value) => {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number' && Number.isNaN(value)) return ['number', 'NaN'];
  if (value === null || typeof value !== 'object') return [typeof value, value];
  if (Array.isArray(value)) return ['array', value.map(canonicalValue)];
  if (isPlainRecord(value)) {
    return ['object', Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])];
  }
  return ['identity', Object.prototype.toString.call(value)];
};

export function formValueFingerprint(values) {
  return JSON.stringify(canonicalValue(values));
}

export function createSetValueConvergenceState(maxSteps = MAX_SET_VALUE_CONVERGENCE_STEPS) {
  return {
    formId: null,
    maxSteps,
    expectedFingerprint: null,
    blockedFingerprint: null,
    seenFingerprints: new Set(),
    steps: 0,
    warningIssued: false,
  };
}

export function resetSetValueConvergence(state, formId = null) {
  state.formId = formId == null ? null : String(formId);
  state.expectedFingerprint = null;
  state.blockedFingerprint = null;
  state.seenFingerprints = new Set();
  state.steps = 0;
  state.warningIssued = false;
}

export function settleSetValueConvergence(state, formId, currentValues) {
  resetSetValueConvergence(state, formId);
  state.seenFingerprints.add(formValueFingerprint(currentValues));
}

export function prepareSetValueTransition(state, {
  formId,
  currentValues,
  nextValues,
}) {
  const normalizedFormId = formId == null ? null : String(formId);
  const currentFingerprint = formValueFingerprint(currentValues);
  const nextFingerprint = formValueFingerprint(nextValues);

  if (state.formId !== normalizedFormId) {
    resetSetValueConvergence(state, normalizedFormId);
  }

  if (state.blockedFingerprint === currentFingerprint) {
    return { apply: false, cycle: true, shouldWarn: false };
  }

  if (state.expectedFingerprint !== currentFingerprint) {
    state.expectedFingerprint = null;
    state.blockedFingerprint = null;
    state.seenFingerprints = new Set([currentFingerprint]);
    state.steps = 0;
    state.warningIssued = false;
  }

  const reachedLimit = state.steps >= state.maxSteps;
  const repeatedState = state.seenFingerprints.has(nextFingerprint);
  if (reachedLimit || repeatedState) {
    state.expectedFingerprint = null;
    state.blockedFingerprint = currentFingerprint;
    const shouldWarn = !state.warningIssued;
    state.warningIssued = true;
    return { apply: false, cycle: true, shouldWarn };
  }

  state.seenFingerprints.add(nextFingerprint);
  state.steps += 1;
  state.expectedFingerprint = nextFingerprint;
  state.blockedFingerprint = null;
  return { apply: true, cycle: false, shouldWarn: false };
}

export function planSemanticFormValueUpdate(state, {
  formId,
  currentValues,
  updates,
}) {
  const nextValues = mergeSemanticFormValueUpdates(currentValues, updates);
  if (nextValues === currentValues) {
    settleSetValueConvergence(state, formId, currentValues);
    return {
      apply: false,
      cycle: false,
      shouldWarn: false,
      nextValues,
    };
  }
  return {
    ...prepareSetValueTransition(state, {
      formId,
      currentValues,
      nextValues,
    }),
    nextValues,
  };
}

export function setValueActionKey(rule, action, ruleIndex, actionIndex) {
  return `action:${rule?.id ?? 'missing'}:${ruleIndex}:${action?.id ?? 'missing'}:${actionIndex}`;
}

export function legacySetValueActionKey(rule, ruleIndex) {
  return `legacy:${rule?.id ?? 'missing'}:${ruleIndex}`;
}