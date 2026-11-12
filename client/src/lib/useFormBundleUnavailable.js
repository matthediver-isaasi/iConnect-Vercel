import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BUNDLE_UNAVAILABLE_EVENT } from './formBundles.js';
import { clearPaymentSubmissionContext } from './formPaymentReturn.js';
import { CART_LOCKED_EVENT, CART_UNLOCKED_EVENT, CART_UNAVAILABLE_EVENT, unlockFormCart } from './formCart.js';
import { useFormCartReservation } from './useFormCartReservation.js';

// Page-level handling matters in paginated forms: the bundle dropdown may be
// unmounted by the time a submit/payment stock conflict arrives.
export function useFormBundleUnavailable(form, setValues, setError, recovery = {}) {
  const queryClient = useQueryClient();
  const latest = useRef({ form, setValues, setError });
  latest.current = { form, setValues, setError, recovery };
  const formId = form?.id;
  const cart = form?.fields?.find(field => field.type === 'sales_cart');
  useFormCartReservation(formId, cart, next => {
    if (!cart) return;
    latest.current.setValues(values => JSON.stringify(values[cart.id]) === JSON.stringify(next)
      ? values : { ...values, [cart.id]: next });
  });
  useEffect(() => {
    if (queryClient.getQueryData(['form-cart-locked', formId]) === undefined) {
      queryClient.setQueryData(['form-cart-locked', formId], false);
    }
    let recovering = false;
    const reservationEnded = async event => {
      if (event.detail?.formId !== formId || recovering) return;
      recovering = true;
      try {
        await latest.current.recovery.rotateIdempotencyKey?.();
        clearPaymentSubmissionContext({ pathname: window.location.pathname, search: window.location.search });
        unlockFormCart(formId);
      } catch {
        latest.current.setError('Your reservation has ended. Reload the form before starting another checkout.');
      } finally { recovering = false; }
    };
    let activityEnabled = false;
    let lastActivitySent = 0;
    let activityRequest = null;
    const touch = (force = false) => {
      if (queryClient.getQueryData(['form-cart-locked', formId]) !== true) return Promise.resolve();
      if (activityRequest) return activityRequest;
      if (!force && Date.now() - lastActivitySent < 30000) return Promise.resolve();
      const key = latest.current.recovery.getIdempotencyKey?.();
      if (!key) return Promise.reject(new Error('Your checkout identity is unavailable. Return to your cart.'));
      lastActivitySent = Date.now();
      activityRequest = fetch('/api/public/form-payment', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cart_activity', form_id: formId, idempotency_key: key }),
      }).then(async response => {
        const result = await response.json();
        if (!response.ok || result.active !== true) throw new Error(result.error || 'We could not check your stock reservation. Please retry.');
      }).finally(() => { activityRequest = null; });
      return activityRequest;
    };
    const activity = () => {
      if (activityEnabled && document.visibilityState === 'visible') touch().catch(error => latest.current.setError(error.message));
    };
    const explicitActivity = event => {
      if (event.detail?.formId !== formId) return;
      event.detail.handled = true;
      touch(true).then(event.detail.resolve, event.detail.reject);
    };
    const handleEdit = async event => {
      if (event.detail?.formId !== formId || recovering) return;
      if (queryClient.getQueryData(['form-cart-locked', formId]) !== true) {
        event.detail?.onReleased?.();
        return;
      }
      recovering = true;
      queryClient.setQueryData(['form-cart-recovery', formId], { busy: true });
      try {
        const current = latest.current;
        const key = current.recovery.getIdempotencyKey?.();
        if (!key || !current.recovery.rotateIdempotencyKey) throw new Error('Return to the payment page to check this payment.');
        const response = await fetch('/api/public/form-payment', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel_cart', form_id: formId, idempotency_key: key }),
        });
        const result = await response.json();
        if (!response.ok || result.released !== true) throw new Error(result.error || 'We could not confirm cancellation. Your cart has been kept; please retry.');
        await current.recovery.rotateIdempotencyKey();
        clearPaymentSubmissionContext({ pathname: window.location.pathname, search: window.location.search });
        unlockFormCart(formId);
        current.setError(null);
        queryClient.setQueryData(['form-cart-recovery', formId], null);
        event.detail?.onReleased?.();
      } catch (error) {
        queryClient.setQueryData(['form-cart-recovery', formId], { error: error.message });
        latest.current.setError(error.message);
        event.detail?.onError?.(error);
      } finally { recovering = false; }
    };
    const handleCart = event => {
      const current = latest.current;
      if (!current.form?.id || event.detail?.formId !== current.form.id) return;
      // Retain identities and quantities, including missing saved options.
      current.setError('A cart item is unavailable. Your cart and other answers have been kept. Review the refreshed options before retrying.');
      queryClient.invalidateQueries({ queryKey: ['public-form-cart'] });
    };
    const handleCartLocked = event => {
      if (event.detail?.formId === formId) {
        queryClient.setQueryData(['form-cart-locked', formId], true);
        activityEnabled = event.detail.provider === 'stripe';
        lastActivitySent = 0;
      }
    };
    const handleCartUnlocked = event => {
      if (event.detail?.formId !== formId) return;
      activityEnabled = false;
      queryClient.setQueryData(['form-cart-locked', formId], false);
      queryClient.invalidateQueries({ queryKey: ['public-form-cart'] });
      queryClient.invalidateQueries({ queryKey: ['form-cart-reservation'] });
      queryClient.invalidateQueries({ queryKey: ['membership-fee-quote', formId] });
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
    document.addEventListener('pointerdown', activity);
    document.addEventListener('keydown', activity);
    window.addEventListener('form-cart-activity', explicitActivity);
    window.addEventListener('form-cart-input', activity);
    window.addEventListener(CART_UNLOCKED_EVENT, handleCartUnlocked);
    window.addEventListener('form-cart-edit-request', handleEdit);
    window.addEventListener('form-cart-reservation-ended', reservationEnded);
    return () => {
      window.removeEventListener(BUNDLE_UNAVAILABLE_EVENT, handle);
      window.removeEventListener(CART_UNAVAILABLE_EVENT, handleCart);
      window.removeEventListener(CART_LOCKED_EVENT, handleCartLocked);
      document.removeEventListener('pointerdown', activity);
      document.removeEventListener('keydown', activity);
      window.removeEventListener('form-cart-activity', explicitActivity);
      window.removeEventListener('form-cart-input', activity);
      window.removeEventListener(CART_UNLOCKED_EVENT, handleCartUnlocked);
      window.removeEventListener('form-cart-edit-request', handleEdit);
      window.removeEventListener('form-cart-reservation-ended', reservationEnded);
      queryClient.removeQueries({ queryKey: ['form-cart-locked', formId], exact: true });
    };
  }, [queryClient, formId]);
  return navigate => {
    window.dispatchEvent(new CustomEvent('form-cart-edit-request', { detail: { formId, onReleased: navigate } }));
  };
}
