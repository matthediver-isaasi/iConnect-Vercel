import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BUNDLE_UNAVAILABLE_EVENT } from './formBundles.js';
import { CART_LOCKED_EVENT, CART_UNLOCKED_EVENT, CART_UNAVAILABLE_EVENT } from './formCart.js';

// Page-level handling matters in paginated forms: the bundle dropdown may be
// unmounted by the time a submit/payment stock conflict arrives.
export function useFormBundleUnavailable(form, setValues, setError) {
  const queryClient = useQueryClient();
  const latest = useRef({ form, setValues, setError });
  latest.current = { form, setValues, setError };
  const formId = form?.id;
  useEffect(() => {
    queryClient.setQueryData(['form-cart-locked', formId], false);
    const handleCart = event => {
      const current = latest.current;
      if (!current.form?.id || event.detail?.formId !== current.form.id) return;
      // Retain identities and quantities, including missing saved options.
      current.setError('A cart item is unavailable. Your cart and other answers have been kept. Review the refreshed options before retrying.');
      queryClient.invalidateQueries({ queryKey: ['public-form-cart'] });
    };
    const handleCartLocked = event => {
      if (event.detail?.formId === formId) queryClient.setQueryData(['form-cart-locked', formId], true);
    };
    const handleCartUnlocked = event => {
      if (event.detail?.formId !== formId) return;
      queryClient.setQueryData(['form-cart-locked', formId], false);
      queryClient.invalidateQueries({ queryKey: ['public-form-cart'] });
    };
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
    window.addEventListener(CART_UNAVAILABLE_EVENT, handleCart);
    window.addEventListener(CART_LOCKED_EVENT, handleCartLocked);
    window.addEventListener(CART_UNLOCKED_EVENT, handleCartUnlocked);
    return () => {
      window.removeEventListener(BUNDLE_UNAVAILABLE_EVENT, handle);
      window.removeEventListener(CART_UNAVAILABLE_EVENT, handleCart);
      window.removeEventListener(CART_LOCKED_EVENT, handleCartLocked);
      window.removeEventListener(CART_UNLOCKED_EVENT, handleCartUnlocked);
      queryClient.removeQueries({ queryKey: ['form-cart-locked', formId], exact: true });
    };
  }, [queryClient, formId]);
}
