import { useEffect, useRef } from 'react';
import { publicClient } from '@/api/publicClient';
import {
  getFormFieldPrefillSourceAnswers,
  getFormFieldPrefillSource,
  mergeReactiveFormFieldPrefill,
  normalizeFormFieldPrefillValues,
  shouldClearFormFieldPrefillError,
  shouldClearFormFieldPrefillSelection,
} from '@/lib/formFieldPrefill';

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