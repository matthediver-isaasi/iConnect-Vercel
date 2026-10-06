import { useEffect, useMemo, useRef, useState } from 'react';
import { publicClient } from '@/api/publicClient';
import {
  getFormFieldPrefillSourceAnswers,
  getFormFieldPrefillSource,
  getConditionalPrefillActionEntries,
  getConditionalPrefillSources,
  getPrefillSourceAnswersForField,
  mergeReactiveFormFieldPrefill,
  normalizeConditionalFormFieldPrefillValues,
  normalizeFormFieldPrefillValues,
  shouldClearFormFieldPrefillError,
  shouldClearFormFieldPrefillSelection,
} from '@/lib/formFieldPrefill';

export function useConditionalFormFieldPrefill(options) {
  return useConditionalFormFieldPrefillState(options).values;
}

export function useConditionalFormFieldPrefillState({ form, formSlug, formValues, enabled = true }) {
  const [valuesByAction, setValuesByAction] = useState({});
  const [settled, setSettled] = useState(null);
  const [failure, setFailure] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const actionEntries = getConditionalPrefillActionEntries(form);
  const sources = getConditionalPrefillSources(form);
  const requestPlan = sources.map(source => ({
    source,
    recordId: formValues?.[source.id],
    sourceAnswers: getPrefillSourceAnswersForField(form, source.id, formValues),
  }));
  const requestSignature = JSON.stringify(requestPlan.map(item => ({
    sourceId: item.source.id,
    recordId: item.recordId,
    sourceAnswers: item.sourceAnswers,
    actionKeys: actionEntries
      .filter(entry => entry.sourceId === String(item.source.id))
      .map(entry => entry.key),
  })));
  const identity = `${form?.id}:${requestSignature}:${retryCount}`;
  const required = enabled && form?.prefill_source === 'form_field'
    && requestPlan.some(item => !shouldClearFormFieldPrefillSelection(item.recordId));

  // The parent applies conditional set-value rules in its effect after these
  // values render. Release in that same effect flush, not when HTTP resolves.
  useEffect(() => {
    if (settled?.identity === identity && settled?.phase === 'fetched') {
      setSettled({ identity, phase: 'applied' });
    }
  }, [identity, settled]);

  useEffect(() => {
    if (!enabled || form?.prefill_source !== 'form_field') {
      setValuesByAction({});
      return undefined;
    }
    setFailure(null);
    let cancelled = false;
    const requests = requestPlan.map(async item => {
        const actionKeys = actionEntries
          .filter(entry => entry.sourceId === String(item.source.id))
          .map(entry => entry.key);
        if (shouldClearFormFieldPrefillSelection(item.recordId)) {
          return { actionKeys, values: {}, clear: true };
        }
        try {
          const response = await publicClient.getFormFieldPrefill(
            formSlug || form?.slug,
            form?.id,
            item.source.id,
            item.recordId,
            item.sourceAnswers,
          );
          return {
            actionKeys,
            values: normalizeConditionalFormFieldPrefillValues(response),
            clear: true,
          };
        } catch (error) {
          if (shouldClearFormFieldPrefillError(error)) {
            return { actionKeys, values: {}, clear: true };
          }
          console.error('[ConditionalFormFieldPrefill] Unable to resolve selected record:', error);
          return { actionKeys, values: {}, clear: false, error };
        }
      });
    Promise.all(requests).then(results => {
      if (cancelled) return;
      const error = results.find(result => result.error)?.error;
      if (error) {
        setFailure({ identity, error });
        return;
      }
      setValuesByAction(current => {
        const next = { ...current };
        for (const result of results) {
          if (result.clear) result.actionKeys.forEach(key => delete next[key]);
          Object.assign(next, result.values);
        }
        return next;
      });
      setSettled({ identity, phase: 'fetched' });
    });
    return () => { cancelled = true; };
  // requestSignature is a stable projection of only the source selections and
  // answers that can affect their eligibility.
  }, [enabled, form?.id, form?.prefill_source, formSlug, requestSignature, retryCount]);

  const error = required && failure?.identity === identity ? {
    message: "We couldn't load the selected record's data. Please retry.",
    retry: () => setRetryCount(count => count + 1),
  } : null;
  const values = useMemo(() => valuesByAction, [valuesByAction]);
  return { values, pending: required && !(settled?.identity === identity && settled.phase === 'applied'), error };
}

// Shared reactive runtime used by every form surface. The API validates the
// persisted source and mappings; the client deliberately sends only the form
// identity, selected record and current source answers.
export function useFormFieldPrefill({
  form,
  formSlug,
  formValues,
  setFormValues,
  enabled = true,
  protectedFieldIds = [],
}) {
  const trackedRef = useRef({});
  const initialValuesRef = useRef({});
  const initialValuesCapturedRef = useRef(false);
  const [settledIdentity, setSettledIdentity] = useState(null);
  const [failure, setFailure] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const source = getFormFieldPrefillSource(form);
  const selectedRecordId = source ? formValues?.[source.id] : null;
  const sourceAnswers = getFormFieldPrefillSourceAnswers(form, formValues);
  const sourceAnswersSignature = JSON.stringify(sourceAnswers);
  const protectedFieldIdsSignature = JSON.stringify(
    [...new Set((protectedFieldIds || []).map(String))].sort(),
  );
  const identity = JSON.stringify([form?.id, source?.id, selectedRecordId, sourceAnswersSignature, retryCount]);
  const required = enabled && form?.prefill_source === 'form_field'
    && source && !shouldClearFormFieldPrefillSelection(selectedRecordId);

  useEffect(() => {
    trackedRef.current = {};
    initialValuesRef.current = {};
    initialValuesCapturedRef.current = false;
  }, [form?.id]);

  useEffect(() => {
    if (!enabled || form?.prefill_source !== 'form_field') return undefined;
    let cancelled = false;
    setFailure(null);
    const protectedFields = new Set((protectedFieldIds || []).map(String));
    if (!initialValuesCapturedRef.current) {
      const replaceableInitialValues = {};
      for (const field of form?.fields || []) {
        const isInitialized = field.type === 'boolean'
          || field.type === 'terms_conditions'
          || !!field.default_country
          || (Array.isArray(field.default_countries) && field.default_countries.length > 0)
          || (field.default_value !== undefined && field.default_value !== null && field.default_value !== '')
          || field.starts_hidden === true
          || field.starts_hidden === 'true';
        if (isInitialized
          && !protectedFields.has(String(field.id))
          && Object.prototype.hasOwnProperty.call(formValues || {}, field.id)) {
          replaceableInitialValues[field.id] = formValues[field.id];
        }
      }
      initialValuesRef.current = replaceableInitialValues;
      initialValuesCapturedRef.current = true;
    }

    const apply = (resolvedValues, clear = false) => {
      if (cancelled) return;
      setFormValues(current => {
        const result = mergeReactiveFormFieldPrefill({
          currentValues: current,
          resolvedValues,
          trackedValues: trackedRef.current,
          replaceableInitialValues: initialValuesRef.current,
          protectedFieldIds,
          clear,
        });
        trackedRef.current = result.trackedValues;
        return result.values;
      });
      // Both updates commit together: no unlocked render with old answers.
      setSettledIdentity(identity);
    };

    if (!source || shouldClearFormFieldPrefillSelection(selectedRecordId)) {
      apply({}, true);
      return () => { cancelled = true; };
    }

    const request = typeof publicClient.getFormFieldPrefill === 'function'
      ? publicClient.getFormFieldPrefill(
        formSlug || form?.slug,
        form?.id,
        source.id,
        selectedRecordId,
        sourceAnswers,
      )
      : publicClient.getFormDropdownPrefill(
        formSlug || form?.slug,
        form?.id,
        selectedRecordId,
        sourceAnswers,
      );
    Promise.resolve(request).then(response => apply(normalizeFormFieldPrefillValues(form, response)))
      .catch(error => {
        if (shouldClearFormFieldPrefillError(error)) {
          apply({}, true);
          return;
        }
        // Do not clear a valid previous fill on a transient lookup failure.
        console.error('[FormFieldPrefill] Unable to resolve selected record:', error);
        if (!cancelled) setFailure({ identity, error });
      });

    return () => { cancelled = true; };
  }, [enabled, form?.id, form?.prefill_source, form?.prefill_source_field_id,
    form?.prefill_field_id, formSlug, selectedRecordId, source?.id,
    sourceAnswersSignature, protectedFieldIdsSignature, setFormValues, retryCount]);
  return {
    pending: !!required && settledIdentity !== identity,
    error: required && failure?.identity === identity ? {
      message: "We couldn't load the selected record's data. Please retry.",
      retry: () => setRetryCount(count => count + 1),
    } : null,
  };
}