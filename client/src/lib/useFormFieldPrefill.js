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

export function useConditionalFormFieldPrefill({ form, formSlug, formValues, enabled = true }) {
  const [valuesByAction, setValuesByAction] = useState({});
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

  useEffect(() => {
    if (!enabled || form?.prefill_source !== 'form_field') {
      setValuesByAction({});
      return undefined;
    }
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
          return { actionKeys, values: {}, clear: false };
        }
      });
    Promise.all(requests).then(results => {
      if (cancelled) return;
      setValuesByAction(current => {
        const next = { ...current };
        for (const result of results) {
          if (result.clear) result.actionKeys.forEach(key => delete next[key]);
          Object.assign(next, result.values);
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  // requestSignature is a stable projection of only the source selections and
  // answers that can affect their eligibility.
  }, [enabled, form?.id, form?.prefill_source, formSlug, requestSignature]);

  return useMemo(() => valuesByAction, [valuesByAction]);
}

// Shared reactive runtime used by every form surface. The API validates the
// persisted source and mappings; the client deliberately sends only the form
// identity, selected record and current source answers.
export function useFormFieldPrefill({ form, formSlug, formValues, setFormValues, enabled = true }) {
  const trackedRef = useRef({});
  const source = getFormFieldPrefillSource(form);
  const selectedRecordId = source ? formValues?.[source.id] : null;
  const sourceAnswers = getFormFieldPrefillSourceAnswers(form, formValues);
  const sourceAnswersSignature = JSON.stringify(sourceAnswers);

  useEffect(() => {
    trackedRef.current = {};
  }, [form?.id]);

  useEffect(() => {
    if (!enabled || form?.prefill_source !== 'form_field') return undefined;
    let cancelled = false;

    const apply = (resolvedValues, clear = false) => {
      if (cancelled) return;
      setFormValues(current => {
        const result = mergeReactiveFormFieldPrefill({
          currentValues: current,
          resolvedValues,
          trackedValues: trackedRef.current,
          clear,
        });
        trackedRef.current = result.trackedValues;
        return result.values;
      });
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
      });

    return () => { cancelled = true; };
  }, [enabled, form?.id, form?.prefill_source, form?.prefill_source_field_id,
    form?.prefill_field_id, formSlug, selectedRecordId, source?.id,
    sourceAnswersSignature, setFormValues]);
}