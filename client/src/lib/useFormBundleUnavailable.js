import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BUNDLE_UNAVAILABLE_EVENT } from './formBundles.js';

// Page-level handling matters in paginated forms: the bundle dropdown may be
// unmounted by the time a submit/payment stock conflict arrives.
export function useFormBundleUnavailable(form, setValues, setError) {
  const queryClient = useQueryClient();
  const latest = useRef({ form, setValues, setError });
  latest.current = { form, setValues, setError };
  useEffect(() => {
    const handle = event => {
      const current = latest.current;
      if (!current.form?.id || event.detail?.formId !== current.form.id) return;
      const fields = (current.form.fields || []).filter(field => field.type === 'sales_bundle'
        && (!event.detail.fieldId || field.id === event.detail.fieldId));
      if (!fields.length) return;
      current.setValues(values => {
        const next = { ...values };
        fields.forEach(field => { next[field.id] = ''; });
        return next;
      });
      current.setError('That bundle is no longer available. Your other answers have been kept. Please choose again.');
      queryClient.invalidateQueries({ queryKey: ['public-form-bundles'] });
    };
    window.addEventListener(BUNDLE_UNAVAILABLE_EVENT, handle);
    return () => window.removeEventListener(BUNDLE_UNAVAILABLE_EVENT, handle);
  }, [queryClient]);
}
