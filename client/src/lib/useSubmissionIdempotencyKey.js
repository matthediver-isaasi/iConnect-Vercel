import { useRef, useCallback } from 'react';

// Duplicate-submission guard shared by every public-form surface that POSTs
// to /api/public/form-submission (FormView, EmbedForm, canvas/iEdit form
// blocks). One idempotency key per form-filling session: sent with every
// submit attempt so double-clicks, retries and second-tab resubmits of the
// SAME fill collapse server-side to a single row. Rotate ONLY after a
// successful submit so a genuine follow-up submission from the same page
// load gets a fresh key.
export function useSubmissionIdempotencyKey() {
  const keyRef = useRef(null);

  const getIdempotencyKey = useCallback(() => {
    if (!keyRef.current) {
      keyRef.current =
        (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
    return keyRef.current;
  }, []);

  const rotateIdempotencyKey = useCallback(() => {
    keyRef.current = null;
  }, []);

  return { getIdempotencyKey, rotateIdempotencyKey };
}
