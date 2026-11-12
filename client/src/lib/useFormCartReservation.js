import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { normalizeCartAnswer } from '../../../shared/formCart.js';

const tokenEvent = 'form-cart-reservation-token';
const empty = { version: 1, lines: [] };
export const reservationKey = formId => ['form-cart-reservation', publicClient.getTenantSlug(), formId];
const storageKey = formId => `form-cart-reservation:${publicClient.getTenantSlug()}:${formId}`;
function readToken(formId) {
  try { return sessionStorage.getItem(storageKey(formId)); } catch { return null; }
}
function saveToken(formId, token) {
  try {
    if (token) sessionStorage.setItem(storageKey(formId), token);
    else sessionStorage.removeItem(storageKey(formId));
  } catch { /* The mounted session still works if browser storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(tokenEvent, { detail: { formId, token } }));
}

export function formatReservationTime(reservation, now = Date.now()) {
  const remaining = Math.max(0, Math.ceil((Date.parse(reservation.expiresAt) - now
    + (reservation.clockOffset || 0)) / 1000));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
}

// Shared by the form page and its Cart / Cart view. The page subscription
// keeps expiry active while the respondent is on a page without either field.
export function useFormCartReservation(formId, field, onUpdate, savedValue) {
  const client = useQueryClient();
  const [token, setToken] = useState(() => formId ? readToken(formId) : null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const latest = useRef(onUpdate);
  latest.current = onUpdate;
  const message = useQuery({ queryKey: [...reservationKey(formId), 'message'], queryFn: () => null, enabled: false });
  useEffect(() => {
    setToken(formId ? readToken(formId) : null);
    const handler = event => { if (event.detail?.formId === formId) setToken(event.detail.token); };
    window.addEventListener(tokenEvent, handler);
    return () => window.removeEventListener(tokenEvent, handler);
  }, [formId]);
  useEffect(() => {
    if (formId && !token && savedValue?.reservation_id) saveToken(formId, savedValue.reservation_id);
  }, [formId, token, savedValue?.reservation_id]);
  const stamp = reservation => ({ ...reservation, clockOffset: Date.now() - Date.parse(reservation.serverNow) });
  const query = useQuery({
    queryKey: [...reservationKey(formId), token],
    queryFn: async () => {
      const result = await publicClient.updateFormCartReservation(formId, field.id, {
        action: 'reservation_status', reservation_id: token,
      });
      const current = client.getQueryData([...reservationKey(formId), token]);
      if (current && (current.version || 0) > (result.reservation.version || 0)) return current;
      return stamp(result.reservation);
    },
    enabled: !!formId && !!field && !!token && !busy,
    retry: false, staleTime: 0,
    refetchInterval: query => {
      if (['consumed', 'released', 'missing'].includes(query.state.data?.state)) return false;
      const remaining = Date.parse(query.state.data?.expiresAt || '') - Date.now()
        + (query.state.data?.clockOffset || 0);
      return remaining > 0 ? Math.min(15000, Math.max(1000, remaining)) : 15000;
    },
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const hold = query.data;
    if (!hold || pending.current || !token || (hold.id && hold.id !== token)) return;
    if (hold.state === 'shopping') {
      latest.current?.({ ...hold.answer, reservation_id: token });
    } else if (hold.state === 'held') {
      client.setQueryData(['form-cart-locked', formId], true);
    } else if (hold.state === 'consumed') {
      // Keep this completed screen immutable, but do not attach a later,
      // fresh visit to the already-purchased reservation.
      try {
        if (readToken(formId) === token) sessionStorage.removeItem(storageKey(formId));
      } catch { /* No persistent storage to clear. */ }
    } else if (['released', 'missing'].includes(hold.state)) {
      latest.current?.(empty);
      client.setQueryData([...reservationKey(formId), 'message'], 'Your cart reservation has ended. Your cart has been cleared; your other answers have been kept.');
      saveToken(formId, null);
      client.invalidateQueries({ queryKey: ['public-form-cart'] });
      window.dispatchEvent(new CustomEvent('form-cart-reservation-ended', { detail: { formId } }));
    }
  }, [query.data, token, formId, client]);
  const update = async answer => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const id = token || crypto.randomUUID();
    try {
      const result = await publicClient.updateFormCartReservation(formId, field.id, {
        action: 'reserve', reservation_id: id, version: query.data?.version || 0, answer: normalizeCartAnswer(answer),
      });
      const hold = stamp(result.reservation);
      client.setQueryData([...reservationKey(formId), id], hold);
      saveToken(formId, id);
      if (hold.state === 'shopping') {
        latest.current?.({ ...hold.answer, reservation_id: id });
        client.setQueryData([...reservationKey(formId), 'message'], null);
      }
      client.invalidateQueries({ queryKey: ['public-form-cart'] });
    } catch (error) {
      // Retain the bearer even if a response is lost: retry status, never
      // create another hold and silently strand the first reservation.
      saveToken(formId, id);
      client.invalidateQueries({ queryKey: reservationKey(formId) });
      throw error;
    } finally { pending.current = false; setBusy(false); }
  };
  return { token, reservation: query.data, busy, update, error: query.error, message: message.data };
}
